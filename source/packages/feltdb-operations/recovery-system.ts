import { randomUUID } from 'node:crypto';
import type { FeltDBClient } from './feltdb-client.js';
import type { RecoveryCheckpoint } from './types.js';

export interface RecoveryProgress {
  lastProcessedOperationId?: string;
  lastProcessedSequence: number;
  operationsRecovered: number;
  executionsRecovered: number;
  failedOperations: number;
}

/**
 * RecoverySystem: Implement recovery protocol after process crash.
 * Uses FeltDB checkpoints and frontier-based replay to recover incomplete work.
 */
export class RecoverySystem {
  private readonly feltdbClient: FeltDBClient;
  private readonly processId: string;

  constructor(feltdbClient: FeltDBClient) {
    this.feltdbClient = feltdbClient;
    this.processId = process.pid.toString();
  }

  /**
   * Execute full recovery protocol on startup.
   * Returns: progress information about what was recovered.
   */
  async recover(): Promise<RecoveryProgress> {
    if (!this.feltdbClient.isEnabled()) {
      return {
        lastProcessedSequence: 0,
        operationsRecovered: 0,
        executionsRecovered: 0,
        failedOperations: 0,
      };
    }

    if (!this.feltdbClient.operations || !this.feltdbClient.executions || !this.feltdbClient.checkpoints) {
      throw new Error('FeltDB stores not initialized');
    }

    const progress: RecoveryProgress = {
      lastProcessedSequence: 0,
      operationsRecovered: 0,
      executionsRecovered: 0,
      failedOperations: 0,
    };

    try {
      // 1. Get last recovery checkpoint to find frontier
      const lastCheckpoint = await this.feltdbClient.checkpoints.getLatestForProcess(this.processId);
      const frontier = lastCheckpoint?.lastProcessedSequence ?? 0;

      console.log(`Recovery: Starting from frontier ${frontier}`);

      // 2. Query incomplete operations since frontier
      const incompleteOps = await this.feltdbClient.operations.queryIncomplete();

      for (const operation of incompleteOps) {
        try {
          const recovered = await this.recoverOperation(operation.operationId);
          if (recovered) {
            progress.operationsRecovered++;
            progress.lastProcessedOperationId = operation.operationId;
          } else {
            progress.failedOperations++;
          }
        } catch (err) {
          console.error(`Error recovering operation ${operation.operationId}:`, err);
          progress.failedOperations++;
        }
      }

      // 3. Update recovery checkpoint with new frontier
      if (progress.operationsRecovered > 0 || progress.failedOperations > 0) {
        await this.createCheckpoint(progress);
      }

      console.log(`Recovery complete: recovered ${progress.operationsRecovered} operations, failed ${progress.failedOperations}`);
    } catch (err) {
      console.error('Recovery error:', err);
      throw new Error(`Recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return progress;
  }

  /**
   * Recover a single operation.
   * Returns: true if operation was recovered successfully.
   */
  private async recoverOperation(operationId: string): Promise<boolean> {
    if (!this.feltdbClient.operations || !this.feltdbClient.executions) {
      throw new Error('FeltDB stores not initialized');
    }

    const operation = await this.feltdbClient.operations.get(operationId);
    if (!operation) {
      console.warn(`Operation ${operationId} not found during recovery`);
      return false;
    }

    // Already completed
    if (operation.status === 'completed') {
      return true;
    }

    // Already failed
    if (operation.status === 'failed' || operation.status === 'cancelled') {
      return false;
    }

    // Check executions for this operation
    const executions = await this.feltdbClient.executions.queryByOperation(operationId);

    // Check if execution already succeeded (use cached result)
    const succeeded = executions.find((e) => e.status === 'succeeded');
    if (succeeded) {
      await this.feltdbClient.operations.updateStatus(operationId, 'completed');
      console.log(`Recovered operation ${operationId} from cache`);
      return true;
    }

    // Check if execution failed
    const failed = executions.find((e) => e.status === 'failed');
    if (failed) {
      await this.feltdbClient.operations.updateStatus(operationId, 'failed');
      console.log(`Operation ${operationId} failed (error: ${failed.error})`);
      return false;
    }

    // If multiple retry attempts without success, mark as failed
    if (executions.length > 3) {
      await this.feltdbClient.operations.updateStatus(operationId, 'failed');
      console.log(`Operation ${operationId} exceeded max retry attempts`);
      return false;
    }

    // Operation is incomplete but no clear path to resolution
    console.warn(`Operation ${operationId} is incomplete with ${executions.length} executions`);
    return false;
  }

  /**
   * Create a recovery checkpoint marking operations as processed.
   */
  private async createCheckpoint(progress: RecoveryProgress): Promise<void> {
    if (!this.feltdbClient.checkpoints) {
      throw new Error('FeltDB checkpoints store not initialized');
    }

    const checkpoint: RecoveryCheckpoint = {
      checkpointId: randomUUID(),
      scope: 'process' as const,
      ...(progress.lastProcessedOperationId && { lastProcessedOperationId: progress.lastProcessedOperationId }),
      lastProcessedSequence: progress.lastProcessedSequence,
      createdAt: Date.now(),
      processId: this.processId,
    };

    await this.feltdbClient.checkpoints.create(checkpoint);
    console.log(`Created recovery checkpoint with sequence ${checkpoint.lastProcessedSequence}`);
  }

  /**
   * Initialize recovery on host startup.
   * Should be called before resuming normal operations.
   */
  async initialize(): Promise<void> {
    try {
      await this.recover();
      console.log('Recovery initialization complete');
    } catch (err) {
      console.error('Recovery initialization failed:', err);
      throw err;
    }
  }
}

/**
 * Helper function to run recovery and return progress.
 */
export async function runRecovery(feltdbClient: FeltDBClient): Promise<RecoveryProgress> {
  const recovery = new RecoverySystem(feltdbClient);
  return recovery.recover();
}
