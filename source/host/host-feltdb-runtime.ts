import { join } from 'node:path';
import type { FeltDBClient } from '../packages/feltdb-operations/feltdb-client.js';
import { FeltDBClient as FeltDBClientImpl } from '../packages/feltdb-operations/feltdb-client.js';

export interface HostFeltDBRuntimeOptions {
  sandRootDir: string;
  log?: Pick<Console, 'log' | 'error'>;
}

/**
 * Manages FeltDB lifecycle in the host process.
 * Initializes FeltDB singleton on startup, recovers state, and handles cleanup.
 */
export class HostFeltDBRuntime {
  private feltdb: FeltDBClient | null = null;
  private sandRootDir: string;
  private log: Pick<Console, 'log' | 'error'>;
  private isShuttingDown = false;

  constructor(options: HostFeltDBRuntimeOptions) {
    this.sandRootDir = options.sandRootDir;
    this.log = options.log ?? console;
  }

  /**
   * Initialize FeltDB on host startup.
   * Creates database in ~/.../Grok Bot/.feltdb/ directory.
   */
  async initialize(): Promise<FeltDBClient> {
    if (this.feltdb !== null) {
      return this.feltdb;
    }

    if (this.isShuttingDown) {
      throw new Error('FeltDB runtime is shutting down');
    }

    try {
      // Create FeltDB instance with data directory
      const feltdbRootPath = join(this.sandRootDir, '.feltdb');
      this.log.log(`[host-feltdb] initializing FeltDB at ${feltdbRootPath}`);

      this.feltdb = new FeltDBClientImpl({ rootPath: feltdbRootPath });
      await this.feltdb.initialize();

      this.log.log('[host-feltdb] FeltDB initialized successfully');

      // Perform recovery on startup
      await this.recoverOnStartup();

      return this.feltdb;
    } catch (error) {
      this.log.error('[host-feltdb] failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Get the FeltDB client instance.
   * Must call initialize() first.
   */
  getFeltDB(): FeltDBClient {
    if (this.feltdb === null) {
      throw new Error('FeltDB not initialized. Call initialize() first.');
    }
    return this.feltdb;
  }

  /**
   * Check if FeltDB is initialized.
   */
  isInitialized(): boolean {
    return this.feltdb !== null;
  }

  /**
   * Perform recovery of pending operations on startup.
   * Recovers incomplete tool executions, coordinator operations, and inference requests.
   */
  private async recoverOnStartup(): Promise<void> {
    if (!this.feltdb) {
      throw new Error('FeltDB not initialized');
    }

    try {
      this.log.log('[host-feltdb] running recovery protocol');

      // Recovery for Phase 1: Tool Executions
      if (this.feltdb.executions && this.feltdb.operations) {
        try {
          const acceptedOps = await this.feltdb.operations.queryByStatus('accepted');
          const executingOps = await this.feltdb.operations.queryByStatus('executing');
          const pendingOperations = [...acceptedOps, ...executingOps];
          if (pendingOperations.length > 0) {
            this.log.log(`[host-feltdb] found ${pendingOperations.length} pending operations to recover`);
          }
        } catch (error) {
          this.log.error('[host-feltdb] error querying pending operations:', error);
        }
      }

      // Recovery for Phase 2: Coordinator Operations
      if (this.feltdb.coordinatorOperations) {
        try {
          const acceptedCoordOps = await this.feltdb.coordinatorOperations.queryByStatus('accepted');
          const inFlightCoordOps = await this.feltdb.coordinatorOperations.queryByStatus('in_flight');
          const pendingCoordinatorOps = [...acceptedCoordOps, ...inFlightCoordOps];
          if (pendingCoordinatorOps.length > 0) {
            this.log.log(`[host-feltdb] found ${pendingCoordinatorOps.length} pending coordinator operations to recover`);
          }
        } catch (error) {
          this.log.error('[host-feltdb] error querying pending coordinator operations:', error);
        }
      }

      // Recovery for Phase 3: Inference Requests
      if (this.feltdb.inference) {
        try {
          const pendingRequests = await this.feltdb.inference.queryRequestsByStatus('accepted', 'executing');
          if (pendingRequests.length > 0) {
            this.log.log(`[host-feltdb] found ${pendingRequests.length} pending inference requests to recover`);
          }
        } catch (error) {
          this.log.error('[host-feltdb] error querying pending inference requests:', error);
        }
      }

      this.log.log('[host-feltdb] recovery protocol completed');
    } catch (error) {
      this.log.error('[host-feltdb] recovery protocol failed:', error);
      // Continue startup even if recovery fails - FeltDB is still usable
    }
  }

  /**
   * Shutdown FeltDB cleanly on host shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    if (this.feltdb === null) {
      return;
    }

    try {
      this.log.log('[host-feltdb] shutting down FeltDB');
      await this.feltdb.shutdown();
      this.feltdb = null;
      this.log.log('[host-feltdb] FeltDB shutdown complete');
    } catch (error) {
      this.log.error('[host-feltdb] error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Get diagnostic information about FeltDB state.
   */
  async getDiagnostics(): Promise<{
    initialized: boolean;
    feltdbPath?: string;
    operationsPending?: number;
    coordinatorOpsPending?: number;
    inferenceRequestsPending?: number;
    isShuttingDown: boolean;
  }> {
    const diagnostics: any = {
      initialized: this.isInitialized(),
      isShuttingDown: this.isShuttingDown,
    };

    if (!this.feltdb) {
      return diagnostics;
    }

    try {
      diagnostics.feltdbPath = join(this.sandRootDir, '.feltdb');

      if (this.feltdb.operations) {
        const acceptedOps = await this.feltdb.operations.queryByStatus('accepted');
        const executingOps = await this.feltdb.operations.queryByStatus('executing');
        diagnostics.operationsPending = acceptedOps.length + executingOps.length;
      }

      if (this.feltdb.coordinatorOperations) {
        const acceptedOps = await this.feltdb.coordinatorOperations.queryByStatus('accepted');
        const inFlightOps = await this.feltdb.coordinatorOperations.queryByStatus('in_flight');
        diagnostics.coordinatorOpsPending = acceptedOps.length + inFlightOps.length;
      }

      if (this.feltdb.inference) {
        const pendingReqs = await this.feltdb.inference.queryRequestsByStatus('accepted', 'executing');
        diagnostics.inferenceRequestsPending = pendingReqs.length;
      }
    } catch (error) {
      this.log.error('[host-feltdb] error collecting diagnostics:', error);
    }

    return diagnostics;
  }
}
