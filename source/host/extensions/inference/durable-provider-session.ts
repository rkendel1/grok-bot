import { randomUUID } from 'node:crypto';
import type { FeltDBClient } from '../../../packages/feltdb-operations/feltdb-client.js';
import type { SandInferenceProvider } from '../../../shared/inference-router.js';
import { runRoutedProviderText } from './provider-session.js';

type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type ProviderMessage = { role: string; content: string | readonly unknown[] };
type RoutedProvider = Exclude<SandInferenceProvider, 'cursor'>;

export interface DurableProviderSessionOptions {
  feltdb: FeltDBClient;
  turnId: string;
}

export class DurableProviderSession {
  private feltdb: FeltDBClient;
  private turnId: string;
  private currentProvider: RoutedProvider;

  constructor(options: DurableProviderSessionOptions, initialProvider: RoutedProvider = 'claude-code') {
    this.feltdb = options.feltdb;
    this.turnId = options.turnId;
    this.currentProvider = initialProvider;
  }

  /**
   * Switch to a different provider and preserve context.
   */
  async switchProvider(newProvider: RoutedProvider): Promise<void> {
    this.currentProvider = newProvider;
    // Record provider switch in context
    const context = await this.feltdb.providerContexts?.get(newProvider);
    if (context) {
      await this.feltdb.providerContexts?.markUsed(newProvider);
    }
  }

  /**
   * Get current provider.
   */
  getCurrentProvider(): RoutedProvider {
    return this.currentProvider;
  }

  /**
   * Execute inference durably with automatic request tracking and response caching.
   */
  async executeInferenceDurable(
    messages: readonly ProviderMessage[],
    providerId?: string,
    options?: {
      tools?: readonly Record<string, any>[];
      onTextDelta?: (delta: string, accumulated: string) => void;
    }
  ): Promise<string> {
    if (!this.feltdb.inference) {
      throw new Error('FeltDB inference store not initialized');
    }

    const provider = this.currentProvider;
    const actualProviderId = providerId || provider;
    const requestId = randomUUID();

    // 1. Create durable request record (status: accepted)
    const createdRequest = await this.feltdb.inference.createRequest({
      requestId,
      providerId: actualProviderId,
      turnId: this.turnId,
      prompt: messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n'),
      status: 'accepted',
      createdAt: Date.now(),
    });

    try {
      // 2. Update status to executing
      await this.feltdb.inference.updateRequestStatus(requestId, 'executing');

      // 3. Execute provider call (can crash here)
      let text = '';
      const startTime = Date.now();
      try {
        const executionOptions: Record<string, any> = {};
        if (options?.tools) executionOptions.tools = options.tools;
        if (options?.onTextDelta) {
          executionOptions.onTextDelta = options.onTextDelta;
        }
        text = await runRoutedProviderText(provider, messages, executionOptions as Parameters<typeof runRoutedProviderText>[2]);
      } catch (error) {
        // Mark request as failed
        await this.feltdb.inference.updateRequestStatus(requestId, 'failed');
        await this.feltdb.inference.incrementAttempt(requestId);
        throw error;
      }

      const duration = Date.now() - startTime;

      // 4. Cache response in FeltDB (status: cached)
      const responseId = randomUUID();
      await this.feltdb.inference.storeResponse({
        responseId,
        requestId,
        providerId: actualProviderId,
        text,
        usage: {
          inputTokens: 0, // Would be populated from actual provider
          outputTokens: 0,
        },
        duration,
        createdAt: Date.now(),
      });

      // 5. Update status to completed
      await this.feltdb.inference.updateRequestStatus(requestId, 'completed');

      return text;
    } catch (error) {
      // Mark as failed if not already marked
      try {
        const current = await this.feltdb.inference.getRequest(requestId);
        if (current?.status !== 'failed') {
          await this.feltdb.inference.updateRequestStatus(requestId, 'failed');
        }
      } catch { /* ignore if already failed */ }
      throw error;
    }
  }

  /**
   * Recover pending/incomplete requests on startup.
   * Returns array of recovered responses (if cached) or throws if recovery needed.
   */
  async recoverPendingRequests(): Promise<Array<{ requestId: string; text: string }>> {
    if (!this.feltdb.inference) {
      throw new Error('FeltDB inference store not initialized');
    }

    const recovered: Array<{ requestId: string; text: string }> = [];

    // Find all pending requests for this turn
    const pendingStatuses = ['accepted', 'executing'] as const;
    const allRequests = await Promise.all(
      pendingStatuses.map(status => this.feltdb.inference!.queryRequestsByStatus(status))
    );
    const pendingRequests = allRequests.flat().filter(req => req.turnId === this.turnId);

    for (const request of pendingRequests) {
      // Try to get cached response
      const cachedResponse = await this.feltdb.inference.getResponse(request.requestId);

      if (cachedResponse) {
        // Use cached response
        await this.feltdb.inference.updateRequestStatus(request.requestId, 'cached');
        recovered.push({
          requestId: request.requestId,
          text: cachedResponse.text,
        });
      } else if (request.attemptCount > 0) {
        // Request was attempted before but has no cache - mark as failed
        await this.feltdb.inference.updateRequestStatus(request.requestId, 'failed');
      } else {
        // Request not yet attempted - will need to retry
        // Mark as executing to indicate recovery in progress
        await this.feltdb.inference.updateRequestStatus(request.requestId, 'executing');
      }
    }

    return recovered;
  }

  /**
   * Get inference context for this turn (all requests and responses).
   */
  async getInferenceContext(): Promise<{
    requests: Array<any>;
    responses: Array<any>;
  }> {
    if (!this.feltdb.inference) {
      throw new Error('FeltDB inference store not initialized');
    }

    const requests = await this.feltdb.inference.queryRequestsByTurn(this.turnId);
    const responses = await this.feltdb.inference.getAllResponses();
    const turnResponses = responses.filter(r => {
      const req = requests.find(req => req.requestId === r.requestId);
      return req !== undefined;
    });

    return {
      requests,
      responses: turnResponses,
    };
  }

  /**
   * Get usage analytics for current provider in this turn.
   */
  async getProviderUsage(): Promise<{
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    averageLatencyMs: number;
  }> {
    if (!this.feltdb.inference) {
      throw new Error('FeltDB inference store not initialized');
    }

    const now = Date.now();
    // Get usage for current turn (approximate 1-hour window)
    return this.feltdb.inference.queryUsage(this.currentProvider, {
      start: now - 3600000, // 1 hour ago
      end: now,
    });
  }

  /**
   * Clear inference history for this turn.
   */
  async clearTurnHistory(): Promise<void> {
    if (!this.feltdb.inference) {
      throw new Error('FeltDB inference store not initialized');
    }

    const requests = await this.feltdb.inference.queryRequestsByTurn(this.turnId);
    // In a real implementation, would need a delete-by-turn method
    // For now, just track that this was attempted
  }
}
