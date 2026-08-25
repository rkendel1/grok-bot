import type { FeltDBClient } from '../../../packages/feltdb-operations/feltdb-client.js';
import type { SandInferenceProvider } from '../../../shared/inference-router.js';
import { DurableProviderSession } from './durable-provider-session.js';

type RoutedProvider = Exclude<SandInferenceProvider, 'cursor'>;
type ProviderMessage = { role: string; content: string | readonly unknown[] };

/**
 * Gateway API for inference operations.
 * Provides endpoints for provider switching, inference execution, and context queries.
 */
export class InferenceGatewayAPI {
  private feltdb: FeltDBClient;
  private sessions: Map<string, DurableProviderSession> = new Map();

  constructor(feltdb: FeltDBClient) {
    this.feltdb = feltdb;
  }

  /**
   * Get or create a durable provider session for a turn.
   */
  private getSession(turnId: string): DurableProviderSession {
    if (!this.sessions.has(turnId)) {
      this.sessions.set(turnId, new DurableProviderSession({ feltdb: this.feltdb, turnId }, 'claude-code'));
    }
    return this.sessions.get(turnId)!;
  }

  /**
   * Switch to a different provider.
   * POST /api/inference/switch-provider
   */
  async switchProvider(args: unknown): Promise<{ success: boolean }> {
    const payload = args as any;
    if (!payload.turnId || !payload.provider) {
      throw new Error('Missing required fields: turnId, provider');
    }

    const session = this.getSession(payload.turnId);
    const provider = payload.provider as RoutedProvider;

    // Validate provider
    const validProviders: RoutedProvider[] = ['claude-code', 'codex', 'openrouter'];
    if (!validProviders.includes(provider)) {
      throw new Error(`Invalid provider: ${provider}. Valid providers: ${validProviders.join(', ')}`);
    }

    await session.switchProvider(provider);

    return { success: true };
  }

  /**
   * Execute inference on the current or specified provider.
   * POST /api/inference/execute
   */
  async executeInference(args: unknown): Promise<{ text: string; usage: any; provider: string }> {
    const payload = args as any;
    if (!payload.turnId || !payload.messages) {
      throw new Error('Missing required fields: turnId, messages');
    }

    const session = this.getSession(payload.turnId);
    const messages = payload.messages as ProviderMessage[];
    const providerId = payload.providerId;
    const options = payload.options;

    const text = await session.executeInferenceDurable(messages, providerId, options);

    return {
      text,
      usage: { inputTokens: 0, outputTokens: 0 }, // Usage tracked in FeltDB
      provider: session.getCurrentProvider()
    };
  }

  /**
   * Get inference context including provider, request history, and cached responses.
   * GET /api/inference/context
   */
  async getInferenceContext(args: unknown): Promise<{
    currentProvider: string;
    providers: any[];
    requestHistory: any[];
    responseCache: any[];
  }> {
    const payload = args as any;
    if (!payload.turnId) {
      throw new Error('Missing required field: turnId');
    }

    const session = this.getSession(payload.turnId);
    const context = await session.getInferenceContext();

    // Query provider contexts
    const providers: any[] = [];
    try {
      // Get all provider contexts from FeltDB
      if (this.feltdb.providerContexts) {
        // Fetch provider contexts - this would need to be implemented in the store
        // providers = []; // TODO: Implement provider listing
      }
    } catch (error) {
      console.error('Error fetching providers:', error);
    }

    return {
      currentProvider: session.getCurrentProvider(),
      providers,
      requestHistory: context.requests || [],
      responseCache: context.responses || []
    };
  }

  /**
   * Get provider usage analytics.
   */
  async getProviderUsage(args: unknown): Promise<any> {
    const payload = args as any;
    if (!payload.turnId) {
      throw new Error('Missing required field: turnId');
    }

    const session = this.getSession(payload.turnId);
    return await session.getProviderUsage();
  }

  /**
   * Get current provider.
   */
  getCurrentProvider(args: unknown): string {
    const payload = args as any;
    if (!payload.turnId) {
      throw new Error('Missing required field: turnId');
    }

    const session = this.getSession(payload.turnId);
    return session.getCurrentProvider();
  }
}
