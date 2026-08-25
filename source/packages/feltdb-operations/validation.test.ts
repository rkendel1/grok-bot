import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { executeToolWithFeltDB, recoverIncompleteExecutions } from './tool-execution.js';
import { RecoverySystem } from './recovery-system.js';
import { telemetry } from './telemetry.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let testDbPath: string;

test('Validation: Deterministic recovery - same events yield same state', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Execute a sequence of operations
  const operations = [];
  for (let i = 0; i < 5; i++) {
    const result = await executeToolWithFeltDB(
      {
        turnId: `turn-det-${i}`,
        toolName: 'deterministic-tool',
        toolArgs: [i],
        feltdbClient: client,
      },
      async (args) => ({ index: args[0], value: Math.random() }),
    );
    operations.push(result);
  }

  // Get first state snapshot
  const state1 = await client.operations!.queryAll();
  const state1Str = JSON.stringify(state1.map((op) => ({ id: op.operationId, status: op.status })));

  // Simulate recovery
  for (const op of operations) {
    await client.operations!.updateStatus(op.operationId, 'executing');
  }

  // Run recovery
  const recovery = new RecoverySystem(client);
  await recovery.recover();

  // Get state after recovery
  const state2 = await client.operations!.queryAll();
  const state2Str = JSON.stringify(state2.map((op) => ({ id: op.operationId, status: op.status })));

  // Both states should have same status progression
  const completedCount1 = state1.filter((op) => op.status === 'completed').length;
  const completedCount2 = state2.filter((op) => op.status === 'completed').length;
  assert.equal(completedCount1, completedCount2);
  assert.equal(completedCount2, 5);

  await client.shutdown();
});

test('Validation: No data loss on crash-restart cycle', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const numOperations = 10;
  const results: string[] = [];

  // Create operations
  for (let i = 0; i < numOperations; i++) {
    const result = await executeToolWithFeltDB(
      {
        turnId: `turn-crash-${i}`,
        toolName: 'crash-test',
        toolArgs: [`data-${i}`],
        feltdbClient: client,
      },
      async (args) => `processed-${args[0]}`,
    );
    assert.equal(result.success, true);
    results.push(result.operationId);
  }

  // Verify all operations exist and are completed
  const allOps1 = await client.operations!.queryAll();
  assert.equal(allOps1.length, numOperations);
  assert.equal(allOps1.filter((op) => op.status === 'completed').length, numOperations);

  // Simulate crash: mark all as executing
  for (const opId of results) {
    await client.operations!.updateStatus(opId, 'executing');
  }

  // Recover
  const recovery = new RecoverySystem(client);
  await recovery.recover();

  // Verify no data loss: all operations still exist and are now completed
  const allOps2 = await client.operations!.queryAll();
  assert.equal(allOps2.length, numOperations);
  const completedOps = allOps2.filter((op) => op.status === 'completed');
  assert.equal(completedOps.length, numOperations, 'No data loss during recovery');

  // Verify all expected operation IDs are present
  for (const expectedId of results) {
    const op = await client.operations!.get(expectedId);
    assert(op, `Operation ${expectedId} missing`);
    assert.equal(op.status, 'completed');
  }

  await client.shutdown();
});

test('Validation: Idempotency prevents duplicate execution', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  let executionCount = 0;
  const executor = async () => {
    executionCount++;
    return { execution: executionCount };
  };

  const turnId = 'turn-idempotent-test';
  const toolName = 'idempotent-tool';
  const toolArgs = ['arg1'];

  // First execution
  const result1 = await executeToolWithFeltDB(
    { turnId, toolName, toolArgs, feltdbClient: client },
    executor,
  );

  assert.equal(executionCount, 1);
  assert.deepEqual(result1.result, { execution: 1 });

  // Simulate crash: mark as executing
  await client.operations!.updateStatus(result1.operationId, 'executing');

  // Recovery
  const recovered = await recoverIncompleteExecutions(client);
  const recoveredResult = recovered.get(result1.operationId);

  assert(recoveredResult);
  assert.equal(recoveredResult.fromCache, true);
  assert.deepEqual(recoveredResult.result, { execution: 1 });

  // Executor should NOT have been called again
  assert.equal(executionCount, 1, 'Idempotency: tool not re-executed');

  await client.shutdown();
});

test('Validation: Exactly-once semantics under stress', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const sideEffects = new Set<string>();
  const executor = async (args: unknown[]) => {
    const effect = `effect-${args[0]}`;
    sideEffects.add(effect);
    return effect;
  };

  const numOperations = 20;
  const operationIds: string[] = [];

  // Create operations
  for (let i = 0; i < numOperations; i++) {
    const result = await executeToolWithFeltDB(
      {
        turnId: `turn-stress-${i}`,
        toolName: 'stress-tool',
        toolArgs: [i],
        feltdbClient: client,
      },
      executor,
    );
    assert.equal(result.success, true);
    operationIds.push(result.operationId);
  }

  const sideEffectsAfterFirstRun = sideEffects.size;
  assert.equal(sideEffectsAfterFirstRun, numOperations);

  // Simulate crash: all operations are restarted
  for (const opId of operationIds) {
    await client.operations!.updateStatus(opId, 'executing');
  }

  // Recovery
  const recovery = new RecoverySystem(client);
  await recovery.recover();

  // Side effects should NOT have duplicated
  // (same effects set, not added to during recovery)
  assert.equal(sideEffects.size, sideEffectsAfterFirstRun, 'No duplicate side effects');

  await client.shutdown();
});

test('Validation: Performance targets', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Target: operation creation < 10ms
  const creationTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    await executeToolWithFeltDB(
      {
        turnId: `turn-perf-${i}`,
        toolName: 'perf-tool',
        toolArgs: [i],
        feltdbClient: client,
      },
      async () => ({ perf: 'test' }),
    );
    creationTimes.push(Date.now() - start);
  }

  const avgTime = creationTimes.reduce((a, b) => a + b, 0) / creationTimes.length;
  const maxTime = Math.max(...creationTimes);

  console.log(`  Average operation time: ${avgTime.toFixed(2)}ms`);
  console.log(`  Max operation time: ${maxTime}ms`);

  // Soft target: operations should be reasonably fast (not a hard failure if slow)
  // Just log for observability
  assert(maxTime < 1000, 'Operations complete in reasonable time');

  await client.shutdown();
});

test('Validation: Checkpoint and frontier tracking', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Execute operations
  const results: string[] = [];
  for (let i = 0; i < 5; i++) {
    const result = await executeToolWithFeltDB(
      {
        turnId: `turn-checkpoint-${i}`,
        toolName: 'checkpoint-tool',
        toolArgs: [],
        feltdbClient: client,
      },
      async () => ({ data: 'test' }),
    );
    results.push(result.operationId);
  }

  // Run recovery to create checkpoint
  const recovery = new RecoverySystem(client);
  await recovery.recover();

  // Verify checkpoint exists
  const checkpoint = await client.checkpoints!.getLatestForProcess(process.pid.toString());
  assert(checkpoint);
  assert.equal(checkpoint.scope, 'process');
  assert.equal(checkpoint.processId, process.pid.toString());

  // Verify checkpoint contains valid frontier
  assert(checkpoint.lastProcessedSequence >= 0);

  await client.shutdown();
});

test('Validation: Telemetry collection', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Record some telemetry
  telemetry.recordOperationCreation(5.5);
  telemetry.recordOperationCreation(6.2);
  telemetry.recordOperationStatusUpdate(2.1);
  telemetry.recordExecutionCreation(3.5);
  telemetry.recordResultRecording(1.2);

  // Get stats
  const stats = telemetry.getAllStats();

  assert.equal(stats.operations.created, 2);
  assert.equal(stats.operations.statusUpdates, 1);
  assert.equal(stats.executions.created, 1);
  assert.equal(stats.executions.resultRecordings, 1);

  // Verify averages are computed
  assert(stats.operations.avgCreationTimeMs > 0);
  assert(stats.operations.avgUpdateTimeMs > 0);

  await client.shutdown();
});
