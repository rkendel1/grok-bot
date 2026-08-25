import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operation } from './types.js';

let testDbPath: string;

test('OperationStore: create and get operation', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.operations) throw new Error('Operations store not initialized');

  const operationId = randomUUID();
  const operation: Omit<Operation, 'version'> = {
    operationId,
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'test-key-1',
    authorityProcess: process.pid.toString(),
  };

  const created = await client.operations.create(operation);
  assert.equal(created.operationId, operationId);
  assert.equal(created.version, 1);
  assert.equal(created.status, 'accepted');

  const fetched = await client.operations.get(operationId);
  assert(fetched);
  assert.equal(fetched.operationId, operationId);
  assert.equal(fetched.status, 'accepted');

  await client.shutdown();
});

test('OperationStore: update operation status', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.operations) throw new Error('Operations store not initialized');

  const operationId = randomUUID();
  const operation: Omit<Operation, 'version'> = {
    operationId,
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'test-key-2',
    authorityProcess: process.pid.toString(),
  };

  await client.operations.create(operation);

  const updated = await client.operations.updateStatus(operationId, 'executing');
  assert.equal(updated.status, 'executing');
  assert.equal(updated.version, 2);
  assert(updated.startedAt);

  const fetched = await client.operations.get(operationId);
  assert(fetched);
  assert.equal(fetched.status, 'executing');

  await client.shutdown();
});

test('OperationStore: complete operation', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.operations) throw new Error('Operations store not initialized');

  const operationId = randomUUID();
  const operation: Omit<Operation, 'version'> = {
    operationId,
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'test-key-3',
    authorityProcess: process.pid.toString(),
  };

  await client.operations.create(operation);

  const resultSnapshot = new Uint8Array([1, 2, 3]);
  const completed = await client.operations.complete(operationId, resultSnapshot);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultSnapshot, resultSnapshot);
  assert(completed.completedAt);

  const fetched = await client.operations.get(operationId);
  assert(fetched);
  assert.equal(fetched.status, 'completed');

  await client.shutdown();
});

test('OperationStore: query incomplete operations', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.operations) throw new Error('Operations store not initialized');

  const op1 = await client.operations.create({
    operationId: randomUUID(),
    kind: 'execution',
    status: 'accepted',
    createdAt: Date.now(),
    idempotencyKey: 'test-key-4',
    authorityProcess: process.pid.toString(),
  });

  const op2 = await client.operations.create({
    operationId: randomUUID(),
    kind: 'execution',
    status: 'executing',
    createdAt: Date.now(),
    idempotencyKey: 'test-key-5',
    authorityProcess: process.pid.toString(),
  });

  const op3 = await client.operations.create({
    operationId: randomUUID(),
    kind: 'execution',
    status: 'completed',
    createdAt: Date.now(),
    idempotencyKey: 'test-key-6',
    authorityProcess: process.pid.toString(),
  });

  const incomplete = await client.operations.queryIncomplete();
  assert(incomplete.length >= 2); // At least op1 and op2
  assert(incomplete.some((op) => op.operationId === op1.operationId));
  assert(incomplete.some((op) => op.operationId === op2.operationId));
  assert(!incomplete.some((op) => op.operationId === op3.operationId));

  await client.shutdown();
});
