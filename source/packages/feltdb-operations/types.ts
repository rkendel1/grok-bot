// FeltDB Collections: Aggregate-Based Design for Durable Operations

// Operation: Track a unit of durable work accepted by the system
export interface Operation {
  // Identity
  operationId: string;
  kind: 'turn' | 'execution' | 'coordination';

  // Lifecycle
  status: 'accepted' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  // Idempotency
  idempotencyKey: string;

  // Authority
  authorityProcess: string;

  // Recovery
  checkpoint?: Uint8Array;
  resultSnapshot?: Uint8Array;

  // Metadata
  metadata?: Record<string, unknown>;

  // Versioning (for concurrent update detection)
  version: number;
}

// Execution: Track specific tool/sandbox execution with results
export interface Execution {
  // Identity
  executionId: string;
  operationId: string;

  // Execution details
  kind: 'tool' | 'subagent' | 'mcp_call';
  name: string;
  arguments: Uint8Array;

  // Result
  status: 'pending' | 'executing' | 'succeeded' | 'failed';
  result?: Uint8Array;
  error?: string;

  // Timestamps
  createdAt: number;
  executedAt?: number;
  completedAt?: number;

  // Recovery
  attemptCount: number;
  lastAttemptAt?: number;

  // Idempotency
  idempotencyKey: string;
}

// Recovery Checkpoint: Mark durable frontier for replay
export interface RecoveryCheckpoint {
  // Identity
  checkpointId: string;
  scope: 'application' | 'process' | 'session';

  // Frontier
  lastProcessedOperationId?: string;
  lastProcessedSequence: number;

  // State
  frontier?: Uint8Array;

  // Metadata
  createdAt: number;
  processId: string;
}

// Coordinator Operation: Track routed coordination operations
export interface CoordinatorOperation {
  // Identity
  operationId: string;
  sequence: number;

  // Operation
  kind: 'route' | 'stream' | 'acknowledge' | 'reaction';
  payload: Record<string, unknown>;

  // Status
  status: 'accepted' | 'in_flight' | 'acknowledged';

  // Recovery
  frontier: number;

  // Timestamps
  createdAt: number;
  acknowledgedAt?: number;

  // Idempotency
  idempotencyKey: string;
}
