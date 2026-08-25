import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let testDbPath: string;

test('InferenceStore: create request', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const requestId = randomUUID();
  const request = await client.inference!.createRequest({
    requestId,
    providerId: 'claude',
    turnId: 'turn-1',
    prompt: 'Hello, world!',
    status: 'accepted',
    createdAt: Date.now(),
  });

  assert.equal(request.requestId, requestId);
  assert.equal(request.providerId, 'claude');
  assert.equal(request.status, 'accepted');
  assert.equal(request.attemptCount, 0);

  await client.shutdown();
});

test('InferenceStore: get request', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const requestId = randomUUID();
  await client.inference!.createRequest({
    requestId,
    providerId: 'openai',
    turnId: 'turn-1',
    prompt: 'Test prompt',
    status: 'accepted',
    createdAt: Date.now(),
  });

  const retrieved = await client.inference!.getRequest(requestId);

  assert(retrieved);
  assert.equal(retrieved.requestId, requestId);
  assert.equal(retrieved.providerId, 'openai');

  await client.shutdown();
});

test('InferenceStore: update request status', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const requestId = randomUUID();
  await client.inference!.createRequest({
    requestId,
    providerId: 'claude',
    turnId: 'turn-1',
    prompt: 'Test',
    status: 'accepted',
    createdAt: Date.now(),
  });

  const executing = await client.inference!.updateRequestStatus(requestId, 'executing');
  assert.equal(executing.status, 'executing');
  assert(executing.executedAt !== undefined);

  const completed = await client.inference!.updateRequestStatus(requestId, 'completed');
  assert.equal(completed.status, 'completed');
  assert(completed.completedAt !== undefined);

  await client.shutdown();
});

test('InferenceStore: increment attempt count', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const requestId = randomUUID();
  const created = await client.inference!.createRequest({
    requestId,
    providerId: 'claude',
    turnId: 'turn-1',
    prompt: 'Test',
    status: 'accepted',
    createdAt: Date.now(),
  });

  assert.equal(created.attemptCount, 0);

  const incremented = await client.inference!.incrementAttempt(requestId);
  assert.equal(incremented.attemptCount, 1);
  assert(incremented.lastAttemptAt !== undefined);

  await client.shutdown();
});

test('InferenceStore: query by status', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const acceptedId = randomUUID();
  const executingId = randomUUID();

  await client.inference!.createRequest({
    requestId: acceptedId,
    providerId: 'claude',
    turnId: 'turn-1',
    prompt: 'Test 1',
    status: 'accepted',
    createdAt: Date.now(),
  });

  await client.inference!.createRequest({
    requestId: executingId,
    providerId: 'openai',
    turnId: 'turn-2',
    prompt: 'Test 2',
    status: 'executing',
    createdAt: Date.now(),
  });

  const executing = await client.inference!.queryRequestsByStatus('executing');

  assert(executing.length >= 1);
  assert(executing.some((r) => r.requestId === executingId));

  await client.shutdown();
});

test('InferenceStore: query by turn', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const turn1 = 'turn-1';
  const turn2 = 'turn-2';

  await client.inference!.createRequest({
    requestId: randomUUID(),
    providerId: 'claude',
    turnId: turn1,
    prompt: 'Test 1',
    status: 'accepted',
    createdAt: Date.now(),
  });

  await client.inference!.createRequest({
    requestId: randomUUID(),
    providerId: 'claude',
    turnId: turn1,
    prompt: 'Test 1b',
    status: 'accepted',
    createdAt: Date.now(),
  });

  await client.inference!.createRequest({
    requestId: randomUUID(),
    providerId: 'openai',
    turnId: turn2,
    prompt: 'Test 2',
    status: 'accepted',
    createdAt: Date.now(),
  });

  const turn1Requests = await client.inference!.queryRequestsByTurn(turn1);

  assert(turn1Requests.length >= 2);
  assert(turn1Requests.every((r) => r.turnId === turn1));

  await client.shutdown();
});

test('InferenceStore: query by provider', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  await client.inference!.createRequest({
    requestId: randomUUID(),
    providerId: 'claude',
    turnId: 'turn-1',
    prompt: 'Test 1',
    status: 'accepted',
    createdAt: Date.now(),
  });

  await client.inference!.createRequest({
    requestId: randomUUID(),
    providerId: 'openai',
    turnId: 'turn-2',
    prompt: 'Test 2',
    status: 'accepted',
    createdAt: Date.now(),
  });

  const claudeRequests = await client.inference!.queryRequestsByProvider('claude');

  assert(claudeRequests.length >= 1);
  assert(claudeRequests.every((r) => r.providerId === 'claude'));

  await client.shutdown();
});

test('InferenceStore: store and retrieve response', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const requestId = randomUUID();
  await client.inference!.createRequest({
    requestId,
    providerId: 'claude',
    turnId: 'turn-1',
    prompt: 'Test',
    status: 'accepted',
    createdAt: Date.now(),
  });

  const responseId = randomUUID();
  const stored = await client.inference!.storeResponse({
    responseId,
    requestId,
    providerId: 'claude',
    text: 'Hello, world!',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
    },
    duration: 123,
    createdAt: Date.now(),
  });

  assert.equal(stored.responseId, responseId);
  assert.equal(stored.text, 'Hello, world!');

  const retrieved = await client.inference!.getResponse(requestId);
  assert(retrieved);
  assert.equal(retrieved.text, 'Hello, world!');

  // Request status should be marked as cached
  const request = await client.inference!.getRequest(requestId);
  assert.equal(request?.status, 'cached');

  await client.shutdown();
});

test('InferenceStore: query usage statistics', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const now = Date.now();

  // Create multiple requests and responses
  for (let i = 0; i < 3; i++) {
    const requestId = randomUUID();
    await client.inference!.createRequest({
      requestId,
      providerId: 'claude',
      turnId: `turn-${i}`,
      prompt: `Test ${i}`,
      status: 'accepted',
      createdAt: now,
    });

    await client.inference!.storeResponse({
      responseId: randomUUID(),
      requestId,
      providerId: 'claude',
      text: `Response ${i}`,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
      },
      duration: 200 + i * 50,
      createdAt: now,
    });
  }

  const usage = await client.inference!.queryUsage('claude', {
    start: now - 1000,
    end: now + 1000,
  });

  assert.equal(usage.totalRequests, 3);
  assert.equal(usage.totalInputTokens, 300);
  assert.equal(usage.totalOutputTokens, 150);
  assert(usage.cacheReadTokens === 30);

  await client.shutdown();
});

test('InferenceStore: delete old responses', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'inference-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const oldTime = Date.now() - 100000;
  const newTime = Date.now();

  // Create old response
  const oldRequestId = randomUUID();
  await client.inference!.createRequest({
    requestId: oldRequestId,
    providerId: 'claude',
    turnId: 'turn-old',
    prompt: 'Old',
    status: 'accepted',
    createdAt: oldTime,
  });

  await client.inference!.storeResponse({
    responseId: randomUUID(),
    requestId: oldRequestId,
    providerId: 'claude',
    text: 'Old response',
    usage: { inputTokens: 1, outputTokens: 1 },
    duration: 1,
    createdAt: oldTime,
  });

  // Create new response
  const newRequestId = randomUUID();
  await client.inference!.createRequest({
    requestId: newRequestId,
    providerId: 'claude',
    turnId: 'turn-new',
    prompt: 'New',
    status: 'accepted',
    createdAt: newTime,
  });

  await client.inference!.storeResponse({
    responseId: randomUUID(),
    requestId: newRequestId,
    providerId: 'claude',
    text: 'New response',
    usage: { inputTokens: 2, outputTokens: 2 },
    duration: 2,
    createdAt: newTime,
  });

  // Delete old responses
  const deleted = await client.inference!.deleteResponsesOlderThan(Date.now() - 50000);

  assert(deleted >= 1);

  // New response should still exist
  const newResponse = await client.inference!.getResponse(newRequestId);
  assert(newResponse);

  await client.shutdown();
});
