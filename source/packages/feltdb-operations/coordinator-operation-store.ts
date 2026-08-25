import type { StateFirstDB } from '@feltdb/core';
import type { CoordinatorOperation } from './types.js';

export interface CoordinatorOperationStoreOptions {
  collectionName?: string;
}

export class CoordinatorOperationStore {
  private readonly db: StateFirstDB;
  private readonly collectionName: string;
  private nextSequenceNumber = 0;

  constructor(db: StateFirstDB, options: CoordinatorOperationStoreOptions = {}) {
    this.db = db;
    this.collectionName = options.collectionName || 'coordinator_operations';
  }

  /**
   * Initialize the store and load the last known sequence number.
   */
  async initialize(): Promise<void> {
    try {
      const latest = await this.getLatest();
      this.nextSequenceNumber = latest ? latest.sequence + 1 : 0;
    } catch (err) {
      throw new Error(`Failed to initialize coordinator store: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Allocate next sequence number atomically.
   * Returns: strictly increasing sequence number.
   */
  private allocateSequence(): number {
    return this.nextSequenceNumber++;
  }

  /**
   * Create a new coordinator operation with auto-allocated sequence number.
   * Must block until write completes.
   */
  async create(
    operationOmitSequence: Omit<CoordinatorOperation, 'sequence'>,
  ): Promise<CoordinatorOperation> {
    const sequence = this.allocateSequence();
    const operation: CoordinatorOperation = {
      ...operationOmitSequence,
      sequence,
    };

    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      await coll.insert(operation, operation.operationId);
      return operation;
    } catch (err) {
      throw new Error(`Failed to create coordinator operation ${operation.operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get a coordinator operation by ID.
   */
  async get(operationId: string): Promise<CoordinatorOperation | null> {
    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      return await coll.get(operationId);
    } catch (err) {
      throw new Error(`Failed to get coordinator operation ${operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Mark coordinator operation as acknowledged (status transition).
   */
  async acknowledge(operationId: string): Promise<CoordinatorOperation> {
    const current = await this.get(operationId);
    if (!current) {
      throw new Error(`Coordinator operation ${operationId} not found`);
    }

    if (current.status === 'acknowledged') {
      return current;
    }

    const updated: CoordinatorOperation = {
      ...current,
      status: 'acknowledged',
      acknowledgedAt: Date.now(),
    };

    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      await coll.update(operationId, updated);
      return updated;
    } catch (err) {
      throw new Error(`Failed to acknowledge coordinator operation ${operationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query unacknowledged coordinator operations.
   */
  async queryUnacknowledged(): Promise<CoordinatorOperation[]> {
    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      return await coll.where((op) => op.status !== 'acknowledged').all();
    } catch (err) {
      throw new Error(`Failed to query unacknowledged coordinator operations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query operations after a given sequence number.
   */
  async queryAfterSequence(sequence: number): Promise<CoordinatorOperation[]> {
    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      return await coll.where((op) => op.sequence > sequence).all();
    } catch (err) {
      throw new Error(`Failed to query operations after sequence ${sequence}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query coordinator operations by status.
   */
  async queryByStatus(status: CoordinatorOperation['status']): Promise<CoordinatorOperation[]> {
    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      return await coll.where((op) => op.status === status).all();
    } catch (err) {
      throw new Error(`Failed to query coordinator operations by status ${status}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query coordinator operations by kind.
   */
  async queryByKind(kind: CoordinatorOperation['kind']): Promise<CoordinatorOperation[]> {
    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      return await coll.where((op) => op.kind === kind).all();
    } catch (err) {
      throw new Error(`Failed to query coordinator operations by kind ${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get the latest coordinator operation (highest sequence).
   */
  async getLatest(): Promise<CoordinatorOperation | null> {
    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      const all = await coll.all();
      if (all.length === 0) return null;
      return all.reduce((latest, current) => (current.sequence > latest.sequence ? current : latest));
    } catch (err) {
      throw new Error(`Failed to get latest coordinator operation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query all coordinator operations in sequence order.
   */
  async queryAll(): Promise<CoordinatorOperation[]> {
    try {
      const coll = this.db.collection<CoordinatorOperation>(this.collectionName);
      const all = await coll.all();
      return all.sort((a, b) => a.sequence - b.sequence);
    } catch (err) {
      throw new Error(`Failed to query all coordinator operations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
