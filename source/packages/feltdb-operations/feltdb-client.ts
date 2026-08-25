import { createFeltDB, type StateFirstDB } from '@feltdb/core';
import { OperationStore } from './operation-store.js';
import { ExecutionStore } from './execution-store.js';
import { RecoveryCheckpointStore } from './recovery-checkpoint-store.js';
import { CoordinatorOperationStore } from './coordinator-operation-store.js';
import { ProviderContextStore } from './provider-context-store.js';
import { InferenceStore } from './inference-store.js';

export interface FeltDBClientOptions {
  rootPath: string;
  enabled?: boolean;
  namespace?: string;
}

/**
 * FeltDBClient: Unified interface for durable operations substrate.
 * Manages all FeltDB collections and provides authority semantics.
 */
export class FeltDBClient {
  private feltdb: StateFirstDB | null = null;
  private readonly rootPath: string;
  private readonly enabled: boolean;
  private readonly namespace: string;

  readonly operations: OperationStore | null = null;
  readonly executions: ExecutionStore | null = null;
  readonly checkpoints: RecoveryCheckpointStore | null = null;
  readonly coordinatorOperations: CoordinatorOperationStore | null = null;
  readonly providerContexts: ProviderContextStore | null = null;
  readonly inference: InferenceStore | null = null;

  constructor(options: FeltDBClientOptions) {
    this.rootPath = options.rootPath;
    this.enabled = options.enabled !== false;
    this.namespace = options.namespace || 'grok-bot';
  }

  /**
   * Initialize FeltDB and all stores.
   * Must be called before any operations.
   */
  async initialize(): Promise<void> {
    if (!this.enabled) {
      console.warn('FeltDBClient is disabled');
      return;
    }

    try {
      this.feltdb = createFeltDB({
        namespace: this.namespace,
        path: this.rootPath,
      });

      // Assign stores (typescript will complain, but we're initializing readonly fields)
      (this as any).operations = new OperationStore(this.feltdb);
      (this as any).executions = new ExecutionStore(this.feltdb);
      (this as any).checkpoints = new RecoveryCheckpointStore(this.feltdb);
      (this as any).coordinatorOperations = new CoordinatorOperationStore(this.feltdb);
      (this as any).providerContexts = new ProviderContextStore({ db: this.feltdb, rootPath: this.rootPath });
      (this as any).inference = new InferenceStore({ db: this.feltdb, rootPath: this.rootPath });

      // Initialize coordinator with last known sequence
      if (this.coordinatorOperations) {
        await this.coordinatorOperations.initialize();
      }

      console.log('FeltDB initialized successfully at', this.rootPath);
    } catch (err) {
      throw new Error(`Failed to initialize FeltDB: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Check if FeltDB is enabled and initialized.
   */
  isEnabled(): boolean {
    return this.enabled && this.feltdb !== null;
  }

  /**
   * Shutdown FeltDB gracefully.
   */
  async shutdown(): Promise<void> {
    if (this.feltdb) {
      try {
        // FeltDB doesn't require explicit close, but keep for future compatibility
        this.feltdb = null;
      } catch (err) {
        console.error('Error shutting down FeltDB:', err);
      }
    }
  }
}
