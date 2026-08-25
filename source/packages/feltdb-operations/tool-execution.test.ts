import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { executeToolWithFeltDB, recoverIncompleteExecutions } from './tool-execution.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDbPath: string;

test('executeToolWithFeltDB: successful execution', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  let executedCount = 0;
  const executor = async (args: unknown[]) => {
    executedCount++;
    return { result: 'success', args };
  };

  const result = await executeToolWithFeltDB(
    {
      turnId: 'turn-1',
      toolName: 'echo',
      toolArgs: ['hello'],
      feltdbClient: client,
    },
    executor,
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.result, { result: 'success', args: ['hello'] });
  assert.equal(result.fromCache, false);
  assert.equal(executedCount, 1);

  const operation = await client.operations!.get(result.operationId);
  assert(operation);
  assert.equal(operation.status, 'completed');

  const execution = await client.executions!.get(result.executionId);
  assert(execution);
  assert.equal(execution.status, 'succeeded');

  await client.shutdown();
});

test('executeToolWithFeltDB: execution error', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const error = new Error('Tool failed');
  const executor = async () => {
    throw error;
  };

  const result = await executeToolWithFeltDB(
    {
      turnId: 'turn-2',
      toolName: 'failing-tool',
      toolArgs: [],
      feltdbClient: client,
    },
    executor,
  );

  assert.equal(result.success, false);
  assert(result.error);
  assert(result.error.includes('Tool failed'));

  const operation = await client.operations!.get(result.operationId);
  assert(operation);
  assert.equal(operation.status, 'failed');

  const execution = await client.executions!.get(result.executionId);
  assert(execution);
  assert.equal(execution.status, 'failed');

  await client.shutdown();
});

test('recoverIncompleteExecutions: finds succeeded execution', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Execute a tool successfully
  let executedCount = 0;
  const executor = async () => {
    executedCount++;
    return { recovered: 'result' };
  };

  const firstResult = await executeToolWithFeltDB(
    {
      turnId: 'turn-3',
      toolName: 'test-recovery',
      toolArgs: ['arg1'],
      feltdbClient: client,
    },
    executor,
  );

  assert.equal(executedCount, 1);
  assert.equal(firstResult.success, true);

  // Simulate a crash by creating a new operation in executing state
  const operationId = firstResult.operationId;
  await client.operations!.updateStatus(operationId, 'executing');

  // Recover incomplete operations
  const recovered = await recoverIncompleteExecutions(client);

  // Should find the operation with cached result
  assert(recovered.has(operationId));
  const recoveredResult = recovered.get(operationId);
  assert(recoveredResult);
  assert.equal(recoveredResult.success, true);
  assert.equal(recoveredResult.fromCache, true);
  assert.deepEqual(recoveredResult.result, { recovered: 'result' });

  // Original executor should not have been called again (no re-execution)
  assert.equal(executedCount, 1);

  await client.shutdown();
});

test('recoverIncompleteExecutions: finds failed execution', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Execute a tool that fails
  const executor = async () => {
    throw new Error('Tool error');
  };

  const firstResult = await executeToolWithFeltDB(
    {
      turnId: 'turn-4',
      toolName: 'failing-recovery',
      toolArgs: [],
      feltdbClient: client,
    },
    executor,
  );

  assert.equal(firstResult.success, false);

  // Simulate state where operation is executing
  const operationId = firstResult.operationId;
  await client.operations!.updateStatus(operationId, 'executing');

  // Recover incomplete operations
  const recovered = await recoverIncompleteExecutions(client);

  // Should find the operation with error
  assert(recovered.has(operationId));
  const recoveredResult = recovered.get(operationId);
  assert(recoveredResult);
  assert.equal(recoveredResult.success, false);
  assert(recoveredResult.error);

  await client.shutdown();
});

test('executeToolWithFeltDB: idempotency prevents duplicate execution', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  let executedCount = 0;
  const executor = async () => {
    executedCount++;
    return { value: executedCount };
  };

  // First execution
  const result1 = await executeToolWithFeltDB(
    {
      turnId: 'turn-5',
      toolName: 'idempotent-tool',
      toolArgs: ['arg1'],
      feltdbClient: client,
    },
    executor,
  );

  assert.equal(executedCount, 1);
  assert.deepEqual(result1.result, { value: 1 });

  // Recovery: operation is marked as executing
  await client.operations!.updateStatus(result1.operationId, 'executing');

  // Recover and re-run
  const recovered = await recoverIncompleteExecutions(client);
  const recoveredResult = recovered.get(result1.operationId);

  assert(recoveredResult);
  assert.equal(recoveredResult.fromCache, true);
  assert.deepEqual(recoveredResult.result, { value: 1 }); // Cached result!

  // Executor was NOT called again
  assert.equal(executedCount, 1);

  await client.shutdown();
});
