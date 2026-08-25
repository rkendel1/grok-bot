import { randomUUID } from 'node:crypto';
import type { StateFirstDB } from '@feltdb/core';

// Provider context: store provider credentials, settings, and state
export interface ProviderContext {
  providerId: string;
  kind: 'claude' | 'openai' | 'openrouter' | 'custom';
  credentials?: {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
  };
  settings: {
    model: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  lastUsedAt: number;
  createdAt: number;
  version: number;
}

export interface ProviderContextStoreOptions {
  db: StateFirstDB;
  rootPath: string;
}

export class ProviderContextStore {
  private db: StateFirstDB;
  private collectionName = 'provider_contexts';

  constructor(options: ProviderContextStoreOptions) {
    this.db = options.db;
  }

  /**
   * Create a new provider context durably.
   */
  async create(context: Omit<ProviderContext, 'version'>): Promise<ProviderContext> {
    const contextWithVersion: ProviderContext = {
      ...context,
      version: 1,
    };

    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      await coll.insert(contextWithVersion, context.providerId);
      return contextWithVersion;
    } catch (err) {
      throw new Error(`Failed to create provider context: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get provider context by provider ID.
   */
  async get(providerId: string): Promise<ProviderContext | undefined> {
    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      const result = await coll.get(providerId);
      return result ?? undefined;
    } catch (err) {
      throw new Error(`Failed to get provider context ${providerId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get all provider contexts.
   */
  async getAll(): Promise<ProviderContext[]> {
    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      return await coll.where(() => true).all();
    } catch (err) {
      throw new Error(`Failed to query provider contexts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update provider context settings (non-credential fields).
   */
  async updateSettings(
    providerId: string,
    settings: Partial<ProviderContext['settings']>
  ): Promise<ProviderContext> {
    const current = await this.get(providerId);
    if (!current) {
      throw new Error(`Provider context ${providerId} not found`);
    }

    const updated: ProviderContext = {
      ...current,
      settings: {
        ...current.settings,
        ...settings,
      },
      version: current.version + 1,
      lastUsedAt: Date.now(),
    };

    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      await coll.update(providerId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to update provider context settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update provider credentials.
   */
  async updateCredentials(
    providerId: string,
    credentials: ProviderContext['credentials']
  ): Promise<ProviderContext> {
    const current = await this.get(providerId);
    if (!current) {
      throw new Error(`Provider context ${providerId} not found`);
    }

    const updated: ProviderContext = {
      ...current,
      ...(credentials && { credentials }),
      version: current.version + 1,
    };

    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      await coll.update(providerId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to update provider credentials: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update last used timestamp.
   */
  async markUsed(providerId: string): Promise<ProviderContext> {
    const current = await this.get(providerId);
    if (!current) {
      throw new Error(`Provider context ${providerId} not found`);
    }

    const updated: ProviderContext = {
      ...current,
      lastUsedAt: Date.now(),
    };

    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      await coll.update(providerId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to mark provider as used: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Delete provider context.
   */
  async delete(providerId: string): Promise<void> {
    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      await coll.update(providerId, undefined as any);
    } catch (err) {
      throw new Error(`Failed to delete provider context: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get most recently used provider.
   */
  async getMostRecentlyUsed(): Promise<ProviderContext | undefined> {
    try {
      const contexts = await this.getAll();
      if (contexts.length === 0) return undefined;
      return contexts.reduce((prev, current) =>
        current.lastUsedAt > prev.lastUsedAt ? current : prev
      );
    } catch (err) {
      throw new Error(`Failed to get most recently used provider: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query provider contexts by kind.
   */
  async getByKind(kind: ProviderContext['kind']): Promise<ProviderContext[]> {
    try {
      const coll = this.db.collection<ProviderContext>(this.collectionName);
      return await coll.where((ctx) => ctx.kind === kind).all();
    } catch (err) {
      throw new Error(`Failed to query providers by kind: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
