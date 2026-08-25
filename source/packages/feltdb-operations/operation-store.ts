import type { StateFirstDB } from '@feltdb/core';
import type { Operation } from './types.js';

export interface OperationStoreOptions {
  collectionName?: string;
}

export class OperationStore {
  private readonly db: StateFirstDB;
  private readonly collectionName: string;

  constructor(db: StateFirstDB, options: OperationStoreOptions = {}) {
    this.db = db;
    this.collectionName = options.collectionName || 'operations';
  }

  /**
   * Create a new operation (durable acceptance).
   * Must block until write completes.
   */
  async create(operation: Omit<Operation, 'version'>): Promise<Operation> {
    const operationWithVersion: Operation = {
      ...operation,
      version: 1,
    };

    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      await coll.insert(operationWithVersion, operation.operationId);
      return operationWithVersion;
    } catch (err) {
      throw new Error(`Failed to create operation ${operation.operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get an operation by ID.
   */
  async get(operationId: string): Promise<Operation | null> {
    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      return await coll.get(operationId);
    } catch (err) {
      throw new Error(`Failed to get operation ${operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update operation status atomically.
   * Prevents concurrent updates using version checking.
   */
  async updateStatus(
    operationId: string,
    newStatus: Operation['status'],
  ): Promise<Operation> {
    const current = await this.get(operationId);
    if (!current) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const updated: Operation = {
      ...current,
      status: newStatus,
      version: current.version + 1,
      ...(newStatus === 'executing' && !current.startedAt && { startedAt: Date.now() }),
      ...(
        (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'cancelled') &&
        !current.completedAt && { completedAt: Date.now() }
      ),
    };

    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      await coll.update(operationId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to update operation ${operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update operation with result snapshot and mark as completed.
   */
  async complete(operationId: string, resultSnapshot: Uint8Array): Promise<Operation> {
    const current = await this.get(operationId);
    if (!current) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (current.status === 'completed') {
      return current;
    }

    const updated: Operation = {
      ...current,
      status: 'completed',
      resultSnapshot,
      version: current.version + 1,
      completedAt: Date.now(),
    };

    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      await coll.update(operationId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to complete operation ${operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query operations by status.
   * Returns operations matching the given status.
   */
  async queryByStatus(status: Operation['status']): Promise<Operation[]> {
    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      return await coll.where((op) => op.status === status).all();
    } catch (err) {
      throw new Error(`Failed to query operations by status ${status}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query incomplete operations (executing but not completed).
   */
  async queryIncomplete(): Promise<Operation[]> {
    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      return await coll
        .where((op) => op.status === 'executing' || op.status === 'accepted')
        .all();
    } catch (err) {
      throw new Error(`Failed to query incomplete operations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query operations by authority process.
   */
  async queryByProcess(processId: string): Promise<Operation[]> {
    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      return await coll.where((op) => op.authorityProcess === processId).all();
    } catch (err) {
      throw new Error(`Failed to query operations by process ${processId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query operations created after a given timestamp.
   */
  async queryAfter(timestamp: number): Promise<Operation[]> {
    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      return await coll.where((op) => op.createdAt > timestamp).all();
    } catch (err) {
      throw new Error(`Failed to query operations after ${timestamp}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query all operations.
   */
  async queryAll(): Promise<Operation[]> {
    try {
      const coll = this.db.collection<Operation>(this.collectionName);
      return await coll.all();
    } catch (err) {
      throw new Error(`Failed to query all operations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
