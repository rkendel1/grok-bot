import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecoveryCheckpoint } from './types.js';

let testDbPath: string;

test('RecoveryCheckpointStore: create and get checkpoint', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.checkpoints) throw new Error('Checkpoints store not initialized');

  const checkpointId = randomUUID();
  const checkpoint: RecoveryCheckpoint = {
    checkpointId,
    scope: 'process',
    lastProcessedSequence: 10,
    createdAt: Date.now(),
    processId: process.pid.toString(),
  };

  const created = await client.checkpoints.create(checkpoint);
  assert.equal(created.checkpointId, checkpointId);
  assert.equal(created.lastProcessedSequence, 10);

  const fetched = await client.checkpoints.get(checkpointId);
  assert(fetched);
  assert.equal(fetched.checkpointId, checkpointId);

  await client.shutdown();
});

test('RecoveryCheckpointStore: get latest checkpoint', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.checkpoints) throw new Error('Checkpoints store not initialized');

  const checkpoint1 = await client.checkpoints.create({
    checkpointId: randomUUID(),
    scope: 'application',
    lastProcessedSequence: 5,
    createdAt: Date.now(),
    processId: '123',
  });

  await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay

  const checkpoint2 = await client.checkpoints.create({
    checkpointId: randomUUID(),
    scope: 'application',
    lastProcessedSequence: 10,
    createdAt: Date.now(),
    processId: '123',
  });

  const latest = await client.checkpoints.getLatest();
  assert(latest);
  // latest should be checkpoint2 (most recent)
  assert(latest.lastProcessedSequence >= checkpoint2.lastProcessedSequence);

  await client.shutdown();
});

test('RecoveryCheckpointStore: get by scope', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.checkpoints) throw new Error('Checkpoints store not initialized');

  const cp1 = await client.checkpoints.create({
    checkpointId: randomUUID(),
    scope: 'process',
    lastProcessedSequence: 5,
    createdAt: Date.now(),
    processId: '456',
  });

  const cp2 = await client.checkpoints.create({
    checkpointId: randomUUID(),
    scope: 'application',
    lastProcessedSequence: 10,
    createdAt: Date.now(),
    processId: '456',
  });

  const byProcess = await client.checkpoints.getByScope('process');
  assert(byProcess.length >= 1);
  assert(byProcess.some((c) => c.checkpointId === cp1.checkpointId));

  const byApp = await client.checkpoints.getByScope('application');
  assert(byApp.length >= 1);
  assert(byApp.some((c) => c.checkpointId === cp2.checkpointId));

  await client.shutdown();
});

test('RecoveryCheckpointStore: get latest for process', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'feltdb-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  if (!client.checkpoints) throw new Error('Checkpoints store not initialized');

  const processId = '789';

  const cp1 = await client.checkpoints.create({
    checkpointId: randomUUID(),
    scope: 'process',
    lastProcessedSequence: 5,
    createdAt: Date.now(),
    processId,
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const cp2 = await client.checkpoints.create({
    checkpointId: randomUUID(),
    scope: 'process',
    lastProcessedSequence: 15,
    createdAt: Date.now(),
    processId,
  });

  const latest = await client.checkpoints.getLatestForProcess(processId);
  assert(latest);
  assert.equal(latest.processId, processId);
  assert(latest.lastProcessedSequence >= cp2.lastProcessedSequence);

  await client.shutdown();
});
