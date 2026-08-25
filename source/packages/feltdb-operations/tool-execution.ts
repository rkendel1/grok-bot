import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { FeltDBClient } from './feltdb-client.js';
import type { Operation, Execution } from './types.js';

export interface ToolExecutionOptions {
  turnId: string;
  toolName: string;
  toolArgs: unknown[];
  feltdbClient: FeltDBClient;
}

export interface ToolExecutionResult<T> {
  success: boolean;
  result?: T;
  error?: string;
  operationId: string;
  executionId: string;
  fromCache: boolean;
}

/**
 * Execute a tool with full FeltDB durability semantics.
 * Provides exactly-once execution guarantees even across crashes.
 */
export async function executeToolWithFeltDB<T>(
  options: ToolExecutionOptions,
  executor: (args: unknown[]) => Promise<T>,
): Promise<ToolExecutionResult<T>> {
  const { turnId, toolName, toolArgs, feltdbClient } = options;

  if (!feltdbClient.isEnabled() || !feltdbClient.operations || !feltdbClient.executions) {
    throw new Error('FeltDB not initialized');
  }

  const operationId = randomUUID();
  const executionId = randomUUID();
  const idempotencyKey = createIdempotencyKey(turnId, toolName, toolArgs);
  const processId = process.pid.toString();

  try {
    // 1. Create operation (durable acceptance)
    const operation: Omit<Operation, 'version'> = {
      operationId,
      kind: 'execution',
      status: 'accepted',
      createdAt: Date.now(),
      idempotencyKey,
      authorityProcess: processId,
      metadata: {
        turnId,
        toolName,
        toolArgs,
      },
    };

    await feltdbClient.operations.create(operation);

    // 2. Create execution record (before executing)
    const execution: Execution = {
      executionId,
      operationId,
      kind: 'tool',
      name: toolName,
      arguments: serializeArguments(toolArgs),
      status: 'pending',
      createdAt: Date.now(),
      attemptCount: 0,
      idempotencyKey,
    };

    await feltdbClient.executions.create(execution);

    // 3. Mark execution as executing
    await feltdbClient.executions.markExecuting(executionId);

    // 4. Update operation status
    await feltdbClient.operations.updateStatus(operationId, 'executing');

    // 5. Execute tool (can crash here)
    let result: T;
    try {
      result = await executor(toolArgs);
    } catch (err) {
      // Record error durably
      await feltdbClient.executions.recordError(executionId, String(err));
      await feltdbClient.operations.updateStatus(operationId, 'failed');
      return {
        success: false,
        error: String(err),
        operationId,
        executionId,
        fromCache: false,
      };
    }

    // 6. Record result durably
    const resultSnapshot = serializeResult(result);
    await feltdbClient.executions.recordResult(executionId, resultSnapshot);
    await feltdbClient.operations.complete(operationId, resultSnapshot);

    return {
      success: true,
      result,
      operationId,
      executionId,
      fromCache: false,
    };
  } catch (err) {
    throw new Error(`Failed to execute tool ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Recover incomplete tool executions from FeltDB.
 * Implements the recovery protocol from FELTDB-AUTHORITY-MODEL-v2.
 */
export async function recoverIncompleteExecutions(
  feltdbClient: FeltDBClient,
): Promise<Map<string, ToolExecutionResult<unknown>>> {
  if (!feltdbClient.isEnabled() || !feltdbClient.operations || !feltdbClient.executions) {
    return new Map();
  }

  const recovered = new Map<string, ToolExecutionResult<unknown>>();

  try {
    // 1. Query incomplete operations
    const incompleteOps = await feltdbClient.operations.queryIncomplete();

    for (const operation of incompleteOps) {
      try {
        const executions = await feltdbClient.executions.queryByOperation(operation.operationId);

        // 2. Check if execution already succeeded (use cached result)
        const succeeded = executions.find((e) => e.status === 'succeeded');
        if (succeeded && succeeded.result) {
          const result = deserializeResult(succeeded.result);
          await feltdbClient.operations.updateStatus(operation.operationId, 'completed');
          recovered.set(operation.operationId, {
            success: true,
            result,
            operationId: operation.operationId,
            executionId: succeeded.executionId,
            fromCache: true,
          });
          continue;
        }

        // 3. Check if execution failed
        const failed = executions.find((e) => e.status === 'failed');
        if (failed) {
          await feltdbClient.operations.updateStatus(operation.operationId, 'failed');
          recovered.set(operation.operationId, {
            success: false,
            error: failed.error || 'Unknown error',
            operationId: operation.operationId,
            executionId: failed.executionId,
            fromCache: false,
          });
          continue;
        }

        // 4. If multiple retry attempts, mark as failed
        if (executions.length > 3) {
          await feltdbClient.operations.updateStatus(operation.operationId, 'failed');
          const firstExecution = executions[0];
          if (firstExecution) {
            recovered.set(operation.operationId, {
              success: false,
              error: 'Max retries exceeded',
              operationId: operation.operationId,
              executionId: firstExecution.executionId,
              fromCache: false,
            });
          }
        }
      } catch (err) {
        console.error(`Error recovering operation ${operation.operationId}:`, err);
      }
    }

    console.log(`Recovered ${recovered.size} incomplete operations`);
  } catch (err) {
    console.error('Error during recovery:', err);
  }

  return recovered;
}

/**
 * Create idempotency key from turn ID, tool name, and arguments.
 */
function createIdempotencyKey(turnId: string, toolName: string, args: unknown[]): string {
  const key = `${turnId}:${toolName}:${JSON.stringify(args)}`;
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Serialize arguments to Uint8Array.
 */
function serializeArguments(args: unknown[]): Uint8Array {
  const json = JSON.stringify(args);
  return new TextEncoder().encode(json);
}

/**
 * Serialize result to Uint8Array.
 */
function serializeResult<T>(result: T): Uint8Array {
  const json = JSON.stringify(result);
  return new TextEncoder().encode(json);
}

/**
 * Deserialize result from Uint8Array.
 */
function deserializeResult(data: Uint8Array): unknown {
  const json = new TextDecoder().decode(data);
  return JSON.parse(json);
}
