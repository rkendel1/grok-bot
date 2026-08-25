// Types
export type {
  Operation,
  Execution,
  RecoveryCheckpoint,
  CoordinatorOperation,
} from './types.js';

// Stores
export { OperationStore, type OperationStoreOptions } from './operation-store.js';
export { ExecutionStore, type ExecutionStoreOptions } from './execution-store.js';
export { RecoveryCheckpointStore, type RecoveryCheckpointStoreOptions } from './recovery-checkpoint-store.js';
export { CoordinatorOperationStore, type CoordinatorOperationStoreOptions } from './coordinator-operation-store.js';

// Client
export { FeltDBClient, type FeltDBClientOptions } from './feltdb-client.js';

// Tool Execution Integration
export {
  executeToolWithFeltDB,
  recoverIncompleteExecutions,
  type ToolExecutionOptions,
  type ToolExecutionResult,
} from './tool-execution.js';

// Recovery System
export { RecoverySystem, runRecovery, type RecoveryProgress } from './recovery-system.js';
