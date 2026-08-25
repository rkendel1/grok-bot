import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Execution } from './types.js';

let testDbPath: string;

test('ExecutionStore: create and get execution', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.executions) throw new Error('Executions store not initialized');

  const executionId = randomUUID();
  const operationId = randomUUID();
  const execution: Execution = {
    executionId,
    operationId,
    kind: 'tool',
    name: 'echo',
    arguments: new Uint8Array([1, 2, 3]),
    status: 'pending',
    createdAt: Date.now(),
    attemptCount: 0,
    idempotencyKey: 'exec-key-1',
  };

  const created = await client.executions.create(execution);
  assert.equal(created.executionId, executionId);
  assert.equal(created.status, 'pending');

  const fetched = await client.executions.get(executionId);
  assert(fetched);
  assert.equal(fetched.executionId, executionId);
  assert.equal(fetched.status, 'pending');

  await client.shutdown();
});

test('ExecutionStore: record result (idempotent)', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.executions) throw new Error('Executions store not initialized');

  const executionId = randomUUID();
  const execution: Execution = {
    executionId,
    operationId: randomUUID(),
    kind: 'tool',
    name: 'test-tool',
    arguments: new Uint8Array([1, 2, 3]),
    status: 'executing',
    createdAt: Date.now(),
    attemptCount: 1,
    idempotencyKey: 'exec-key-2',
  };

  await client.executions.create(execution);

  const result1 = new Uint8Array([4, 5, 6]);
  const recorded1 = await client.executions.recordResult(executionId, result1);
  assert.equal(recorded1.status, 'succeeded');
  assert.equal(recorded1.result, result1);
  assert(recorded1.completedAt);

  // Call again with same execution - should return cached result
  const result2 = new Uint8Array([7, 8, 9]);
  const recorded2 = await client.executions.recordResult(executionId, result2);
  assert.equal(recorded2.status, 'succeeded');
  assert.equal(recorded2.result, result1); // Still first result!

  await client.shutdown();
});

test('ExecutionStore: mark as executing', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.executions) throw new Error('Executions store not initialized');

  const executionId = randomUUID();
  const execution: Execution = {
    executionId,
    operationId: randomUUID(),
    kind: 'tool',
    name: 'test-tool',
    arguments: new Uint8Array([1, 2, 3]),
    status: 'pending',
    createdAt: Date.now(),
    attemptCount: 0,
    idempotencyKey: 'exec-key-3',
  };

  await client.executions.create(execution);

  const executing = await client.executions.markExecuting(executionId);
  assert.equal(executing.status, 'executing');
  assert(executing.executedAt);

  await client.shutdown();
});

test('ExecutionStore: query by operation', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.executions) throw new Error('Executions store not initialized');

  const operationId = randomUUID();
  const exec1 = await client.executions.create({
    executionId: randomUUID(),
    operationId,
    kind: 'tool',
    name: 'tool1',
    arguments: new Uint8Array(),
    status: 'pending',
    createdAt: Date.now(),
    attemptCount: 0,
    idempotencyKey: 'exec-key-4',
  });

  const exec2 = await client.executions.create({
    executionId: randomUUID(),
    operationId,
    kind: 'tool',
    name: 'tool2',
    arguments: new Uint8Array(),
    status: 'pending',
    createdAt: Date.now(),
    attemptCount: 0,
    idempotencyKey: 'exec-key-5',
  });

  const byOperation = await client.executions.queryByOperation(operationId);
  assert(byOperation.length >= 2);
  assert(byOperation.some((e) => e.executionId === exec1.executionId));
  assert(byOperation.some((e) => e.executionId === exec2.executionId));

  await client.shutdown();
});

test('ExecutionStore: query incomplete executions', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.executions) throw new Error('Executions store not initialized');

  const pending = await client.executions.create({
    executionId: randomUUID(),
    operationId: randomUUID(),
    kind: 'tool',
    name: 'tool',
    arguments: new Uint8Array(),
    status: 'pending',
    createdAt: Date.now(),
    attemptCount: 0,
    idempotencyKey: 'exec-key-6',
  });

  const executing = await client.executions.create({
    executionId: randomUUID(),
    operationId: randomUUID(),
    kind: 'tool',
    name: 'tool',
    arguments: new Uint8Array(),
    status: 'executing',
    createdAt: Date.now(),
    attemptCount: 1,
    idempotencyKey: 'exec-key-7',
  });

  const completed = await client.executions.create({
    executionId: randomUUID(),
    operationId: randomUUID(),
    kind: 'tool',
    name: 'tool',
    arguments: new Uint8Array(),
    status: 'succeeded',
    createdAt: Date.now(),
    attemptCount: 1,
    result: new Uint8Array(),
    idempotencyKey: 'exec-key-8',
  });

  const incomplete = await client.executions.queryIncomplete();
  assert(incomplete.length >= 2);
  assert(incomplete.some((e) => e.executionId === pending.executionId));
  assert(incomplete.some((e) => e.executionId === executing.executionId));
  assert(!incomplete.some((e) => e.executionId === completed.executionId));

  await client.shutdown();
});
