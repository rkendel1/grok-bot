import type { StateFirstDB } from '@feltdb/core';
import type { RecoveryCheckpoint } from './types.js';

export interface RecoveryCheckpointStoreOptions {
  collectionName?: string;
}

export class RecoveryCheckpointStore {
  private readonly db: StateFirstDB;
  private readonly collectionName: string;

  constructor(db: StateFirstDB, options: RecoveryCheckpointStoreOptions = {}) {
    this.db = db;
    this.collectionName = options.collectionName || 'recovery_checkpoints';
  }

  /**
   * Create a new recovery checkpoint (frontier marker).
   * Must block until write completes.
   */
  async create(checkpoint: RecoveryCheckpoint): Promise<RecoveryCheckpoint> {
    try {
      const coll = this.db.collection<RecoveryCheckpoint>(this.collectionName);
      await coll.insert(checkpoint, checkpoint.checkpointId);
      return checkpoint;
    } catch (err) {
      throw new Error(`Failed to create checkpoint ${checkpoint.checkpointId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get a checkpoint by ID.
   */
  async get(checkpointId: string): Promise<RecoveryCheckpoint | null> {
    try {
      const coll = this.db.collection<RecoveryCheckpoint>(this.collectionName);
      return await coll.get(checkpointId);
    } catch (err) {
      throw new Error(`Failed to get checkpoint ${checkpointId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get the latest recovery checkpoint (most recent).
   * Used on startup to determine replay frontier.
   */
  async getLatest(): Promise<RecoveryCheckpoint | null> {
    try {
      const coll = this.db.collection<RecoveryCheckpoint>(this.collectionName);
      const all = await coll.all();
      if (all.length === 0) return null;
      return all.reduce((latest, current) => (current.createdAt > latest.createdAt ? current : latest));
    } catch (err) {
      throw new Error(`Failed to get latest checkpoint: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get checkpoints by scope.
   */
  async getByScope(scope: RecoveryCheckpoint['scope']): Promise<RecoveryCheckpoint[]> {
    try {
      const coll = this.db.collection<RecoveryCheckpoint>(this.collectionName);
      return await coll.where((cp) => cp.scope === scope).all();
    } catch (err) {
      throw new Error(`Failed to query checkpoints by scope ${scope}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get checkpoints by process ID.
   */
  async getByProcess(processId: string): Promise<RecoveryCheckpoint[]> {
    try {
      const coll = this.db.collection<RecoveryCheckpoint>(this.collectionName);
      return await coll.where((cp) => cp.processId === processId).all();
    } catch (err) {
      throw new Error(`Failed to query checkpoints by process ${processId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get the latest checkpoint for a process.
   */
  async getLatestForProcess(processId: string): Promise<RecoveryCheckpoint | null> {
    try {
      const coll = this.db.collection<RecoveryCheckpoint>(this.collectionName);
      const all = await coll.where((cp) => cp.processId === processId).all();
      if (all.length === 0) return null;
      return all.reduce((latest, current) => (current.createdAt > latest.createdAt ? current : latest));
    } catch (err) {
      throw new Error(`Failed to get latest checkpoint for process ${processId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Query all checkpoints.
   */
  async queryAll(): Promise<RecoveryCheckpoint[]> {
    try {
      const coll = this.db.collection<RecoveryCheckpoint>(this.collectionName);
      return await coll.all();
    } catch (err) {
      throw new Error(`Failed to query all checkpoints: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
