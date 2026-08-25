import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { RecoverySystem, runRecovery } from './recovery-system.js';
import { executeToolWithFeltDB } from './tool-execution.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let testDbPath: string;

test('RecoverySystem: initialize recovery', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Create an operation and mark as executing
  const operationId = randomUUID();
  await client.operations!.create({
    operationId,
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'test-key',
    authorityProcess: process.pid.toString(),
  });

  await client.operations!.updateStatus(operationId, 'executing');

  // Create execution record
  const executionId = randomUUID();
  await client.executions!.create({
    executionId,
    operationId,
    kind: 'tool',
    name: 'test-tool',
    arguments: new Uint8Array(),
    status: 'executing',
    createdAt: Date.now(),
    attemptCount: 1,
    idempotencyKey: 'exec-key',
  });

  // Run recovery
  const recovery = new RecoverySystem(client);
  const progress = await recovery.recover();

  assert.equal(progress.failedOperations, 1);
  const operation = await client.operations!.get(operationId);
  assert(operation);
  assert.equal(operation.status, 'failed');

  await client.shutdown();
});

test('RecoverySystem: recover from cached result', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Execute a tool
  const executor = async () => ({ answer: 42 });
  const result = await executeToolWithFeltDB(
    {
      turnId: 'turn-recovery-1',
      toolName: 'answer-tool',
      toolArgs: [],
      feltdbClient: client,
    },
    executor,
  );

  assert.equal(result.success, true);

  // Simulate crash: mark operation as executing
  await client.operations!.updateStatus(result.operationId, 'executing');

  // Recovery should find cached result
  const recovery = new RecoverySystem(client);
  const progress = await recovery.recover();

  assert.equal(progress.operationsRecovered, 1);
  assert.equal(progress.failedOperations, 0);

  const operation = await client.operations!.get(result.operationId);
  assert(operation);
  assert.equal(operation.status, 'completed');

  await client.shutdown();
});

test('RecoverySystem: handle multiple operations', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Create multiple operations in different states
  const succeedingOp = randomUUID();
  await client.operations!.create({
    operationId: succeedingOp,
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'key1',
    authorityProcess: process.pid.toString(),
  });
  await client.operations!.updateStatus(succeedingOp, 'executing');

  // Add a succeeded execution
  await client.executions!.create({
    executionId: randomUUID(),
    operationId: succeedingOp,
    kind: 'tool',
    name: 'tool1',
    arguments: new Uint8Array(),
    status: 'succeeded',
    createdAt: Date.now(),
    attemptCount: 1,
    result: new TextEncoder().encode('{"result":"ok"}'),
    idempotencyKey: 'exec-key1',
  });

  // Create a failing operation
  const failingOp = randomUUID();
  await client.operations!.create({
    operationId: failingOp,
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'key2',
    authorityProcess: process.pid.toString(),
  });
  await client.operations!.updateStatus(failingOp, 'executing');

  // Add multiple failed executions
  for (let i = 0; i < 4; i++) {
    await client.executions!.create({
      executionId: randomUUID(),
      operationId: failingOp,
      kind: 'tool',
      name: 'tool2',
      arguments: new Uint8Array(),
      status: 'failed',
      error: 'Tool failed',
      createdAt: Date.now(),
      attemptCount: i + 1,
      idempotencyKey: `exec-key2-${i}`,
    });
  }

  // Run recovery
  const recovery = new RecoverySystem(client);
  const progress = await recovery.recover();

  assert.equal(progress.operationsRecovered, 1); // succeedingOp
  assert.equal(progress.failedOperations, 1); // failingOp

  // Verify states
  const succeeded = await client.operations!.get(succeedingOp);
  assert(succeeded);
  assert.equal(succeeded.status, 'completed');

  const failed = await client.operations!.get(failingOp);
  assert(failed);
  assert.equal(failed.status, 'failed');

  await client.shutdown();
});

test('runRecovery: helper function', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Execute a tool
  const executor = async () => ({ result: 'value' });
  const result = await executeToolWithFeltDB(
    {
      turnId: 'turn-recovery-2',
      toolName: 'helper-tool',
      toolArgs: [],
      feltdbClient: client,
    },
    executor,
  );

  // Mark as executing to simulate crash
  await client.operations!.updateStatus(result.operationId, 'executing');

  // Run recovery using helper
  const progress = await runRecovery(client);

  assert.equal(progress.operationsRecovered, 1);

  await client.shutdown();
});

test('RecoverySystem: creates checkpoint', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const operationId = randomUUID();
  await client.operations!.create({
    operationId,
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'checkpoint-test',
    authorityProcess: process.pid.toString(),
  });

  await client.operations!.complete(operationId, new Uint8Array());

  const recovery = new RecoverySystem(client);
  await recovery.recover();

  // Verify checkpoint was created
  const checkpoint = await client.checkpoints!.getLatestForProcess(process.pid.toString());
  assert(checkpoint);
  assert.equal(checkpoint.processId, process.pid.toString());

  await client.shutdown();
});
