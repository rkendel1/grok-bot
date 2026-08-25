import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoordinatorOperation } from './types.js';

let testDbPath: string;

test('CoordinatorOperationStore: create with auto-sequence', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.coordinatorOperations) throw new Error('Coordinator operations store not initialized');

  const op1 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: { destination: 'api1' },
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-1',
  });

  assert.equal(op1.sequence, 0);

  const op2 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: { destination: 'api2' },
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-2',
  });

  assert.equal(op2.sequence, 1);

  await client.shutdown();
});

test('CoordinatorOperationStore: get operation', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.coordinatorOperations) throw new Error('Coordinator operations store not initialized');

  const operationId = randomUUID();
  const op = await client.coordinatorOperations.create({
    operationId,
    kind: 'stream',
    payload: { topic: 'messages' },
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-3',
  });

  const fetched = await client.coordinatorOperations.get(operationId);
  assert(fetched);
  assert.equal(fetched.operationId, operationId);
  assert.equal(fetched.status, 'accepted');

  await client.shutdown();
});

test('CoordinatorOperationStore: acknowledge operation', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.coordinatorOperations) throw new Error('Coordinator operations store not initialized');

  const operationId = randomUUID();
  await client.coordinatorOperations.create({
    operationId,
    kind: 'acknowledge',
    payload: { messageId: 'msg1' },
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-4',
  });

  const acknowledged = await client.coordinatorOperations.acknowledge(operationId);
  assert.equal(acknowledged.status, 'acknowledged');
  assert(acknowledged.acknowledgedAt);

  // Acknowledge again (idempotent)
  const ack2 = await client.coordinatorOperations.acknowledge(operationId);
  assert.equal(ack2.status, 'acknowledged');

  await client.shutdown();
});

test('CoordinatorOperationStore: query unacknowledged', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.coordinatorOperations) throw new Error('Coordinator operations store not initialized');

  const op1 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-5',
  });

  const op2 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'in_flight',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-6',
  });

  const op3 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'acknowledged',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-7',
  });

  const unacked = await client.coordinatorOperations.queryUnacknowledged();
  assert(unacked.length >= 2);
  assert(unacked.some((o) => o.operationId === op1.operationId));
  assert(unacked.some((o) => o.operationId === op2.operationId));
  assert(!unacked.some((o) => o.operationId === op3.operationId));

  await client.shutdown();
});

test('CoordinatorOperationStore: query after sequence', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.coordinatorOperations) throw new Error('Coordinator operations store not initialized');

  const op1 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-8',
  });

  const op2 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-9',
  });

  const op3 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-10',
  });

  const after0 = await client.coordinatorOperations.queryAfterSequence(0);
  assert(after0.length >= 2); // op2 and op3

  const after1 = await client.coordinatorOperations.queryAfterSequence(1);
  assert(after1.length >= 1); // op3

  await client.shutdown();
});

test('CoordinatorOperationStore: get latest', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.coordinatorOperations) throw new Error('Coordinator operations store not initialized');

  const op1 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-11',
  });

  const op2 = await client.coordinatorOperations.create({
    operationId: randomUUID(),
    kind: 'route',
    payload: {},
    status: 'accepted',
    frontier: 0,
    createdAt: Date.now(),
    idempotencyKey: 'coop-key-12',
  });

  const latest = await client.coordinatorOperations.getLatest();
  assert(latest);
  assert.equal(latest.sequence, op2.sequence);

  await client.shutdown();
});
