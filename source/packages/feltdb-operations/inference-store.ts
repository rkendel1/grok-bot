import { randomUUID } from 'node:crypto';
import type { StateFirstDB } from '@feltdb/core';

// Inference request: track requests durably
export interface InferenceRequest {
  requestId: string;
  providerId: string;
  turnId: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  status: 'accepted' | 'executing' | 'completed' | 'failed' | 'cached';
  attemptCount: number;
  createdAt: number;
  executedAt?: number;
  completedAt?: number;
  lastAttemptAt?: number;
  version: number;
}

// Inference response: cache responses durably
export interface InferenceResponse {
  responseId: string;
  requestId: string;
  providerId: string;
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  duration: number;
  createdAt: number;
}

export interface InferenceStoreOptions {
  db: StateFirstDB;
  rootPath: string;
}

export class InferenceStore {
  private db: StateFirstDB;
  private requestsCollectionName = 'inference_requests';
  private responsesCollectionName = 'inference_responses';

  constructor(options: InferenceStoreOptions) {
    this.db = options.db;
  }

  /**
   * Create inference request durably.
   */
  async createRequest(request: Omit<InferenceRequest, 'version' | 'attemptCount'>): Promise<InferenceRequest> {
    const requestWithDefaults: InferenceRequest = {
      ...request,
      version: 1,
      attemptCount: 0,
    };

    try {
      const coll = this.db.collection<InferenceRequest>(this.requestsCollectionName);
      await coll.insert(requestWithDefaults, request.requestId);
      return requestWithDefaults;
    } catch (err) {
      throw new Error(`Failed to create inference request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get inference request by ID.
   */
  async getRequest(requestId: string): Promise<InferenceRequest | undefined> {
    try {
      const coll = this.db.collection<InferenceRequest>(this.requestsCollectionName);
      const result = await coll.get(requestId);
      return result ?? undefined;
    } catch (err) {
      throw new Error(`Failed to get inference request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update request status.
   */
  async updateRequestStatus(requestId: string, status: InferenceRequest['status']): Promise<InferenceRequest> {
    const current = await this.getRequest(requestId);
    if (!current) {
      throw new Error(`Inference request ${requestId} not found`);
    }

    const updated: InferenceRequest = {
      ...current,
      status,
      version: current.version + 1,
      ...(status === 'executing' && { executedAt: Date.now() }),
      ...(status === 'completed' && { completedAt: Date.now() }),
    };

    try {
      const coll = this.db.collection<InferenceRequest>(this.requestsCollectionName);
      await coll.update(requestId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to update request status: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Increment attempt count.
   */
  async incrementAttempt(requestId: string): Promise<InferenceRequest> {
    const current = await this.getRequest(requestId);
    if (!current) {
      throw new Error(`Inference request ${requestId} not found`);
    }

    const updated: InferenceRequest = {
      ...current,
      attemptCount: current.attemptCount + 1,
      lastAttemptAt: Date.now(),
      version: current.version + 1,
    };

    try {
      const coll = this.db.collection<InferenceRequest>(this.requestsCollectionName);
      await coll.update(requestId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to increment attempt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query requests by status.
   */
  async queryRequestsByStatus(...statuses: InferenceRequest['status'][]): Promise<InferenceRequest[]> {
    try {
      const coll = this.db.collection<InferenceRequest>(this.requestsCollectionName);
      return await coll.where((req) => statuses.includes(req.status)).all();
    } catch (err) {
      throw new Error(`Failed to query requests by status: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query requests by turn.
   */
  async queryRequestsByTurn(turnId: string): Promise<InferenceRequest[]> {
    try {
      const coll = this.db.collection<InferenceRequest>(this.requestsCollectionName);
      return await coll.where((req) => req.turnId === turnId).all();
    } catch (err) {
      throw new Error(`Failed to query requests by turn: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query requests by provider.
   */
  async queryRequestsByProvider(providerId: string): Promise<InferenceRequest[]> {
    try {
      const coll = this.db.collection<InferenceRequest>(this.requestsCollectionName);
      return await coll.where((req) => req.providerId === providerId).all();
    } catch (err) {
      throw new Error(`Failed to query requests by provider: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Store inference response (cache result).
   */
  async storeResponse(response: InferenceResponse): Promise<InferenceResponse> {
    try {
      const coll = this.db.collection<InferenceResponse>(this.responsesCollectionName);
      await coll.insert(response, response.responseId);
      // Mark request as cached
      await this.updateRequestStatus(response.requestId, 'cached');
      return response;
    } catch (err) {
      throw new Error(`Failed to store inference response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get response for a request (cache lookup).
   */
  async getResponse(requestId: string): Promise<InferenceResponse | undefined> {
    try {
      const coll = this.db.collection<InferenceResponse>(this.responsesCollectionName);
      const responses = await coll.where((resp) => resp.requestId === requestId).all();
      return responses.length > 0 ? responses[0] : (undefined as InferenceResponse | undefined);
    } catch (err) {
      throw new Error(`Failed to get response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get all responses.
   */
  async getAllResponses(): Promise<InferenceResponse[]> {
    try {
      const coll = this.db.collection<InferenceResponse>(this.responsesCollectionName);
      return await coll.where(() => true).all();
    } catch (err) {
      throw new Error(`Failed to query responses: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query usage statistics for a provider over time range.
   */
  async queryUsage(
    provider: string,
    timeRange: { start: number; end: number }
  ): Promise<{
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    averageLatencyMs: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }> {
    try {
      const responses = await this.getAllResponses();
      const filtered = responses.filter(
        (r) =>
          r.providerId === provider &&
          r.createdAt >= timeRange.start &&
          r.createdAt <= timeRange.end
      );

      if (filtered.length === 0) {
        return {
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          averageLatencyMs: 0,
        };
      }

      const totalInputTokens = filtered.reduce((sum, r) => sum + r.usage.inputTokens, 0);
      const totalOutputTokens = filtered.reduce((sum, r) => sum + r.usage.outputTokens, 0);
      const totalDuration = filtered.reduce((sum, r) => sum + r.duration, 0);
      const cacheReadTokens = filtered.reduce((sum, r) => sum + (r.usage.cacheReadTokens || 0), 0);
      const cacheWriteTokens = filtered.reduce((sum, r) => sum + (r.usage.cacheWriteTokens || 0), 0);

      return {
        totalRequests: filtered.length,
        totalInputTokens,
        totalOutputTokens,
        averageLatencyMs: totalDuration / filtered.length,
        ...(cacheReadTokens > 0 && { cacheReadTokens }),
        ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
      };
    } catch (err) {
      throw new Error(`Failed to query usage: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Delete old responses (cleanup).
   */
  async deleteResponsesOlderThan(beforeTimestamp: number): Promise<number> {
    try {
      const coll = this.db.collection<InferenceResponse>(this.responsesCollectionName);
      const toDelete = await coll.where((resp) => resp.createdAt < beforeTimestamp).all();

      for (const response of toDelete) {
        await coll.update(response.responseId, undefined as any);
      }

      return toDelete.length;
    } catch (err) {
      throw new Error(`Failed to delete old responses: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
