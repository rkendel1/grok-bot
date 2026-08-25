import type { StateFirstDB } from '@feltdb/core';
import type { Execution } from './types.js';

export interface ExecutionStoreOptions {
  collectionName?: string;
}

export class ExecutionStore {
  private readonly db: StateFirstDB;
  private readonly collectionName: string;

  constructor(db: StateFirstDB, options: ExecutionStoreOptions = {}) {
    this.db = db;
    this.collectionName = options.collectionName || 'executions';
  }

  /**
   * Create a new execution record (before executing).
   * Must block until write completes.
   */
  async create(execution: Execution): Promise<Execution> {
    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      await coll.insert(execution, execution.executionId);
      return execution;
    } catch (err) {
      throw new Error(`Failed to create execution ${execution.executionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get an execution by ID.
   */
  async get(executionId: string): Promise<Execution | null> {
    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      return await coll.get(executionId);
    } catch (err) {
      throw new Error(`Failed to get execution ${executionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Record result for an execution durably.
   * Marks execution as succeeded with cached result.
   */
  async recordResult(executionId: string, result: Uint8Array): Promise<Execution> {
    const current = await this.get(executionId);
    if (!current) {
      throw new Error(`Execution ${executionId} not found`);
    }

    // Prevent duplicate success: if already succeeded, return cached result
    if (current.status === 'succeeded') {
      return current;
    }

    const updated: Execution = {
      ...current,
      status: 'succeeded',
      result,
      completedAt: Date.now(),
    };

    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      await coll.update(executionId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to record result for execution ${executionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Record error for an execution and increment attempt count.
   */
  async recordError(executionId: string, error: string): Promise<Execution> {
    const current = await this.get(executionId);
    if (!current) {
      throw new Error(`Execution ${executionId} not found`);
    }

    const updated: Execution = {
      ...current,
      status: 'failed',
      error,
      attemptCount: current.attemptCount + 1,
      lastAttemptAt: Date.now(),
      completedAt: Date.now(),
    };

    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      await coll.update(executionId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to record error for execution ${executionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Mark execution as executing (status transition).
   */
  async markExecuting(executionId: string): Promise<Execution> {
    const current = await this.get(executionId);
    if (!current) {
      throw new Error(`Execution ${executionId} not found`);
    }

    const updated: Execution = {
      ...current,
      status: 'executing',
      executedAt: Date.now(),
    };

    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      await coll.update(executionId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to mark execution as executing ${executionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query executions by parent operation ID.
   */
  async queryByOperation(operationId: string): Promise<Execution[]> {
    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      return await coll.where((e) => e.operationId === operationId).all();
    } catch (err) {
      throw new Error(`Failed to query executions by operation ${operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query executions by status.
   */
  async queryByStatus(status: Execution['status']): Promise<Execution[]> {
    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      return await coll.where((e) => e.status === status).all();
    } catch (err) {
      throw new Error(`Failed to query executions by status ${status}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query executions by idempotency key (for deduplication).
   */
  async queryByIdempotencyKey(idempotencyKey: string): Promise<Execution[]> {
    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      return await coll.where((e) => e.idempotencyKey === idempotencyKey).all();
    } catch (err) {
      throw new Error(`Failed to query executions by key ${idempotencyKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query all incomplete executions (executing or pending).
   */
  async queryIncomplete(): Promise<Execution[]> {
    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      return await coll.where((e) => e.status === 'executing' || e.status === 'pending').all();
    } catch (err) {
      throw new Error(`Failed to query incomplete executions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query all executions.
   */
  async queryAll(): Promise<Execution[]> {
    try {
      const coll = this.db.collection<Execution>(this.collectionName);
      return await coll.all();
    } catch (err) {
      throw new Error(`Failed to query all executions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
