import { randomUUID } from 'node:crypto';
import type { FeltDBClient } from './feltdb-client.js';
import type { CoordinatorOperation } from './types.js';

export interface CoordinatorMessageOptions {
  kind: 'route' | 'stream' | 'acknowledge' | 'reaction';
  payload: Record<string, unknown>;
  destinationId?: string;
  sessionId?: string;
}

export interface CoordinatorSendResult {
  operationId: string;
  sequence: number;
  accepted: boolean;
  error?: string;
}

/**
 * CoordinatorDurability: Make coordinator operations durable via FeltDB.
 * Ensures all coordinator messages are persisted before sending.
 */
export class CoordinatorDurability {
  private readonly feltdbClient: FeltDBClient;
  private readonly processId: string;

  constructor(feltdbClient: FeltDBClient) {
    this.feltdbClient = feltdbClient;
    this.processId = process.pid.toString();
  }

  /**
   * Send a coordinator operation durably.
   * Creates FeltDB record before sending to ensure recovery.
   */
  async sendDurable(options: CoordinatorMessageOptions): Promise<CoordinatorSendResult> {
    const operationId = randomUUID();
    const idempotencyKey = this.createIdempotencyKey(options);

    try {
      if (!this.feltdbClient.isEnabled() || !this.feltdbClient.coordinatorOperations) {
        throw new Error('FeltDB not initialized');
      }

      // 1. Create coordinator operation durably (blocking)
      const operation = await this.feltdbClient.coordinatorOperations.create({
        operationId,
        kind: options.kind,
        payload: options.payload,
        status: 'accepted',
        frontier: 0, // TODO: track current frontier
        createdAt: Date.now(),
        idempotencyKey,
      });

      // 2. Operation is now durable - even if we crash, recovery will find it
      // 3. Send operation (this can fail, but it's idempotent due to FeltDB record)
      // TODO: Send to actual coordinator endpoint
      await this.markInFlight(operation.operationId);

      return {
        operationId,
        sequence: operation.sequence,
        accepted: true,
      };
    } catch (err) {
      return {
        operationId,
        sequence: 0,
        accepted: false,
        error: String(err),
      };
    }
  }

  /**
   * Mark operation as acknowledged (received by destination).
   */
  async acknowledge(operationId: string): Promise<void> {
    if (!this.feltdbClient.coordinatorOperations) {
      throw new Error('FeltDB not initialized');
    }

    await this.feltdbClient.coordinatorOperations.acknowledge(operationId);
  }

  /**
   * Recover unacknowledged coordinator operations.
   * Called on startup to replay coordinator state.
   */
  async recoverOperations(): Promise<CoordinatorOperation[]> {
    if (!this.feltdbClient.isEnabled() || !this.feltdbClient.coordinatorOperations) {
      return [];
    }

    try {
      const unacknowledged = await this.feltdbClient.coordinatorOperations.queryUnacknowledged();
      console.log(`Coordinator recovery: found ${unacknowledged.length} unacknowledged operations`);

      const recovered: CoordinatorOperation[] = [];

      for (const operation of unacknowledged) {
        try {
          // For in_flight operations, retry sending
          if (operation.status === 'in_flight') {
            // TODO: Retry send to coordinator endpoint
            await this.feltdbClient.coordinatorOperations.acknowledge(operation.operationId);
            recovered.push(operation);
          }
          // For accepted operations, they haven't been sent yet
          else if (operation.status === 'accepted') {
            recovered.push(operation);
          }
        } catch (err) {
          console.error(`Error recovering coordinator operation ${operation.operationId}:`, err);
        }
      }

      return recovered;
    } catch (err) {
      console.error('Coordinator recovery error:', err);
      return [];
    }
  }

  /**
   * Get coordinator operations after a given sequence.
   * Used to rebuild routing state from checkpoint.
   */
  async getOperationsAfterSequence(sequence: number): Promise<CoordinatorOperation[]> {
    if (!this.feltdbClient.coordinatorOperations) {
      throw new Error('FeltDB not initialized');
    }

    return this.feltdbClient.coordinatorOperations.queryAfterSequence(sequence);
  }

  /**
   * Query operations by kind (route, stream, acknowledge, reaction).
   */
  async getOperationsByKind(kind: CoordinatorOperation['kind']): Promise<CoordinatorOperation[]> {
    if (!this.feltdbClient.coordinatorOperations) {
      throw new Error('FeltDB not initialized');
    }

    return this.feltdbClient.coordinatorOperations.queryByKind(kind);
  }

  /**
   * Rebuild routing state from coordinator operations.
   * Replays all operations since last checkpoint to reconstruct current state.
   */
  async rebuildRoutingState(fromSequence: number = 0): Promise<Map<string, unknown>> {
    const operations = await this.getOperationsAfterSequence(fromSequence);
    const state = new Map<string, unknown>();

    for (const operation of operations) {
      try {
        this.applyOperationToState(state, operation);
      } catch (err) {
        console.error(`Error applying coordinator operation ${operation.operationId}:`, err);
      }
    }

    return state;
  }

  /**
   * Apply a coordinator operation to the routing state.
   * This is a placeholder - actual implementation depends on coordinator architecture.
   */
  private applyOperationToState(state: Map<string, unknown>, operation: CoordinatorOperation): void {
    switch (operation.kind) {
      case 'route':
        // Apply routing operation to state
        // Example: state.set(`route:${operation.operationId}`, operation.payload);
        break;
      case 'stream':
        // Apply stream operation
        // Example: state.set(`stream:${operation.operationId}`, operation.payload);
        break;
      case 'acknowledge':
        // Apply acknowledgment
        // Example: state.delete(operation.payload.targetId);
        break;
      case 'reaction':
        // Apply reaction
        // Example: state.set(`reaction:${operation.operationId}`, operation.payload);
        break;
    }
  }

  /**
   * Mark operation as in-flight (sent to coordinator).
   */
  private async markInFlight(operationId: string): Promise<void> {
    if (!this.feltdbClient.coordinatorOperations) {
      throw new Error('FeltDB not initialized');
    }

    await this.feltdbClient.coordinatorOperations.markInFlight(operationId);
  }

  /**
   * Create idempotency key for coordinator operation.
   */
  private createIdempotencyKey(options: CoordinatorMessageOptions): string {
    const key = `${options.kind}:${JSON.stringify(options.payload)}`;
    return key;
  }
}

/**
 * Helper to wrap a coordinator client with durability.
 */
export function wrapCoordinatorWithDurability(
  coordinatorClient: unknown,
  feltdbClient: FeltDBClient,
): CoordinatorDurability {
  return new CoordinatorDurability(feltdbClient);
}
