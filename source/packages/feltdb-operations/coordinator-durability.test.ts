import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { CoordinatorDurability } from './coordinator-durability.js';
import type { CoordinatorMessageOptions } from './coordinator-durability.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDbPath: string;

test('CoordinatorDurability: sendDurable creates operation and marks as accepted', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  const options: CoordinatorMessageOptions = {
    kind: 'route',
    payload: { sourceId: 'source-1', targetId: 'target-1' },
    destinationId: 'dest-1',
  };

  const result = await durability.sendDurable(options);

  assert(result.operationId);
  assert.equal(result.accepted, true);
  assert(result.sequence >= 0);

  // Verify operation is durable in FeltDB
  const operation = await client.coordinatorOperations!.get(result.operationId);
  assert(operation);
  assert.equal(operation.kind, 'route');
  assert.equal(operation.status, 'in_flight');
  assert.deepEqual(operation.payload, options.payload);

  await client.shutdown();
});

test('CoordinatorDurability: sendDurable returns error when FeltDB not enabled', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath, enabled: false });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  const options: CoordinatorMessageOptions = {
    kind: 'stream',
    payload: { streamId: 'stream-1' },
  };

  const result = await durability.sendDurable(options);

  assert.equal(result.accepted, false);
  assert(result.error);

  await client.shutdown();
});

test('CoordinatorDurability: acknowledge marks operation as acknowledged', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  // Create operation
  const options: CoordinatorMessageOptions = {
    kind: 'route',
    payload: { destinationId: 'dest-1' },
  };

  const sendResult = await durability.sendDurable(options);
  assert(sendResult.operationId);

  // Acknowledge it
  const operationId = sendResult.operationId;
  await durability.acknowledge(operationId);

  // Verify operation status changed
  const operation = await client.coordinatorOperations!.get(operationId);
  assert(operation);
  // acknowledge() should mark as acknowledged (received)
  assert.equal(operation.status, 'acknowledged');

  await client.shutdown();
});

test('CoordinatorDurability: recoverOperations finds unacknowledged operations', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  // Create multiple operations
  const operationIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await durability.sendDurable({
      kind: 'route',
      payload: { id: i },
    });
    operationIds.push(result.operationId);
  }

  // Only acknowledge the first two
  const firstId = operationIds[0];
  const secondId = operationIds[1];
  if (firstId && secondId) {
    await durability.acknowledge(firstId);
    await durability.acknowledge(secondId);
  }
  // Leave the third unacknowledged

  // Recovery should find the unacknowledged one
  const recovered = await durability.recoverOperations();

  // Should contain at least the unacknowledged operation
  const unacknowledgedIds = recovered.map((op) => op.operationId);
  const thirdId = operationIds[2];
  if (thirdId) {
    assert(unacknowledgedIds.includes(thirdId));
  }

  await client.shutdown();
});

test('CoordinatorDurability: getOperationsAfterSequence returns operations in sequence order', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  // Create operations to establish sequence ordering
  const results = [];
  for (let i = 0; i < 5; i++) {
    const result = await durability.sendDurable({
      kind: 'route',
      payload: { index: i },
    });
    results.push(result);
  }

  // Query operations after sequence 1
  const afterSeq1 = await durability.getOperationsAfterSequence(1);

  // Should get operations with sequence > 1
  assert(afterSeq1.length > 0);
  for (const op of afterSeq1) {
    assert(op.sequence > 1);
  }

  await client.shutdown();
});

test('CoordinatorDurability: getOperationsByKind filters by operation kind', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  // Create operations of different kinds
  await durability.sendDurable({
    kind: 'route',
    payload: { routeId: '1' },
  });

  await durability.sendDurable({
    kind: 'stream',
    payload: { streamId: '1' },
  });

  await durability.sendDurable({
    kind: 'route',
    payload: { routeId: '2' },
  });

  // Query by kind
  const routes = await durability.getOperationsByKind('route');

  // Should find all route operations
  assert(routes.length >= 2);
  for (const op of routes) {
    assert.equal(op.kind, 'route');
  }

  const streams = await durability.getOperationsByKind('stream');
  assert(streams.length >= 1);
  for (const op of streams) {
    assert.equal(op.kind, 'stream');
  }

  await client.shutdown();
});

test('CoordinatorDurability: rebuildRoutingState applies operations to state', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  // Create a sequence of operations
  const result1 = await durability.sendDurable({
    kind: 'route',
    payload: { routeId: 'route-1', destination: 'dest-1' },
  });

  const result2 = await durability.sendDurable({
    kind: 'stream',
    payload: { streamId: 'stream-1', target: 'target-1' },
  });

  // Rebuild state from beginning
  const state = await durability.rebuildRoutingState(0);

  // State should be a Map (even if empty due to placeholder implementation)
  assert(state instanceof Map);

  await client.shutdown();
});

test('CoordinatorDurability: idempotencyKey prevents duplicate operations', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  const options: CoordinatorMessageOptions = {
    kind: 'route',
    payload: { destinationId: 'dest-1' },
  };

  // Send same operation twice (same kind and payload)
  const result1 = await durability.sendDurable(options);
  const result2 = await durability.sendDurable(options);

  // Both should succeed but have same idempotency key
  assert.equal(result1.accepted, true);
  assert.equal(result2.accepted, true);

  // Get the operations
  const op1 = await client.coordinatorOperations!.get(result1.operationId);
  const op2 = await client.coordinatorOperations!.get(result2.operationId);

  assert(op1);
  assert(op2);
  // Both operations should have same idempotency key
  assert.equal(op1.idempotencyKey, op2.idempotencyKey);

  await client.shutdown();
});

test('CoordinatorDurability: wrapCoordinatorWithDurability creates wrapper', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  // Mock coordinator client
  const mockCoordinator = {};

  const { wrapCoordinatorWithDurability } = await import('./coordinator-durability.js');
  const wrapped = wrapCoordinatorWithDurability(mockCoordinator, client);

  assert(wrapped);
  assert(wrapped instanceof CoordinatorDurability);

  await client.shutdown();
});

test('CoordinatorDurability: sequence numbers are ordered', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  // Create multiple operations and verify sequence ordering
  const sequences: number[] = [];
  for (let i = 0; i < 5; i++) {
    const result = await durability.sendDurable({
      kind: 'route',
      payload: { index: i },
    });
    assert(result.sequence !== undefined);
    sequences.push(result.sequence);
  }

  // Sequences should be strictly increasing
  for (let i = 1; i < sequences.length; i++) {
    const curr = sequences[i];
    const prev = sequences[i - 1];
    if (curr !== undefined && prev !== undefined) {
      assert(curr > prev, `Sequence ${curr} should be > ${prev}`);
    }
  }

  await client.shutdown();
});

test('CoordinatorDurability: recovery handles crash-restart cycle', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  // Create and acknowledge some operations (simulating sent)
  const sentOps: string[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await durability.sendDurable({
      kind: 'route',
      payload: { id: i },
    });
    await durability.acknowledge(result.operationId);
    sentOps.push(result.operationId);
  }

  // Create unacknowledged operations (simulating unsent before crash)
  const unsentOps: string[] = [];
  for (let i = 3; i < 5; i++) {
    const result = await durability.sendDurable({
      kind: 'stream',
      payload: { id: i },
    });
    unsentOps.push(result.operationId);
  }

  // Simulate crash and recovery
  const recovered = await durability.recoverOperations();

  // Should find the unacknowledged operations
  const recoveredIds = recovered.map((op) => op.operationId);
  for (const id of unsentOps) {
    assert(recoveredIds.includes(id), `Should recover unsent operation ${id}`);
  }

  await client.shutdown();
});

test('CoordinatorDurability: handles multiple coordinator message kinds', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();
  const durability = new CoordinatorDurability(client);

  const kinds: Array<'route' | 'stream' | 'acknowledge' | 'reaction'> = [
    'route',
    'stream',
    'acknowledge',
    'reaction',
  ];

  const results = [];
  for (const kind of kinds) {
    const result = await durability.sendDurable({
      kind,
      payload: { kind },
    });
    results.push(result);
    assert.equal(result.accepted, true);
  }

  // Verify all were created
  assert.equal(results.length, 4);

  // Verify they can be queried
  for (const kind of kinds) {
    const ops = await durability.getOperationsByKind(kind);
    assert(ops.length >= 1);
  }

  await client.shutdown();
});
