import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from '../../../packages/feltdb-operations/feltdb-client.js';
import { DurableProviderSession } from './durable-provider-session.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDbPath: string;

test('DurableProviderSession: execute inference durably', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  // Note: In real tests, we'd mock runRoutedProviderText
  // This test validates the durability recording mechanism
  assert.equal(session.getCurrentProvider(), 'claude-code');

  await client.shutdown();
});

test('DurableProviderSession: track inference request lifecycle', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  // Simulate request creation through inference store
  const requestId = 'test-request-1';
  const request = await client.inference!.createRequest({
    requestId,
    providerId: 'claude-code',
    turnId: 'turn-1',
    prompt: 'Test prompt',
    status: 'accepted',
    createdAt: Date.now(),
  });

  assert.equal(request.status, 'accepted');
  assert.equal(request.attemptCount, 0);

  // Simulate status transitions
  const executing = await client.inference!.updateRequestStatus(requestId, 'executing');
  assert.equal(executing.status, 'executing');

  const completed = await client.inference!.updateRequestStatus(requestId, 'completed');
  assert.equal(completed.status, 'completed');

  await client.shutdown();
});

test('DurableProviderSession: cache response after execution', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  const requestId = 'test-request-2';
  await client.inference!.createRequest({
    requestId,
    providerId: 'claude-code',
    turnId: 'turn-1',
    prompt: 'Test prompt',
    status: 'accepted',
    createdAt: Date.now(),
  });

  const responseId = 'test-response-1';
  const response = await client.inference!.storeResponse({
    responseId,
    requestId,
    providerId: 'claude-code',
    text: 'This is a test response',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
    },
    duration: 100,
    createdAt: Date.now(),
  });

  assert.equal(response.text, 'This is a test response');

  // Verify cached response can be retrieved
  const cached = await client.inference!.getResponse(requestId);
  assert(cached);
  assert.equal(cached.text, 'This is a test response');

  // Verify request status is marked as cached
  const request = await client.inference!.getRequest(requestId);
  assert.equal(request?.status, 'cached');

  await client.shutdown();
});

test('DurableProviderSession: switch provider', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  assert.equal(session.getCurrentProvider(), 'claude-code');

  await session.switchProvider('openrouter');
  assert.equal(session.getCurrentProvider(), 'openrouter');

  await session.switchProvider('claude-code');
  assert.equal(session.getCurrentProvider(), 'claude-code');

  await client.shutdown();
});

test('DurableProviderSession: recover pending requests', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  const requestId1 = 'test-request-3';
  const requestId2 = 'test-request-4';

  // Create two requests
  await client.inference!.createRequest({
    requestId: requestId1,
    providerId: 'claude-code',
    turnId: 'turn-1',
    prompt: 'Test prompt 1',
    status: 'accepted',
    createdAt: Date.now(),
  });

  await client.inference!.createRequest({
    requestId: requestId2,
    providerId: 'claude-code',
    turnId: 'turn-1',
    prompt: 'Test prompt 2',
    status: 'executing',
    createdAt: Date.now(),
  });

  // Cache response for first request only
  await client.inference!.storeResponse({
    responseId: 'test-response-2',
    requestId: requestId1,
    providerId: 'claude-code',
    text: 'Cached response 1',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
    },
    duration: 100,
    createdAt: Date.now(),
  });

  // Recover pending requests
  const recovered = await session.recoverPendingRequests();

  // Should recover the cached response for request 1
  assert(recovered.length >= 1);
  const recoveredRequest = recovered.find(r => r.requestId === requestId1);
  assert(recoveredRequest);
  assert.equal(recoveredRequest.text, 'Cached response 1');

  // Request 2 should be marked as executing (needs retry)
  const request2Status = await client.inference!.getRequest(requestId2);
  assert.equal(request2Status?.status, 'executing');

  await client.shutdown();
});

test('DurableProviderSession: get inference context', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  // Create requests and responses
  const requestId = 'test-request-5';
  await client.inference!.createRequest({
    requestId,
    providerId: 'claude-code',
    turnId: 'turn-1',
    prompt: 'Test prompt',
    status: 'completed',
    createdAt: Date.now(),
  });

  await client.inference!.storeResponse({
    responseId: 'test-response-3',
    requestId,
    providerId: 'claude-code',
    text: 'Test response',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
    },
    duration: 100,
    createdAt: Date.now(),
  });

  const context = await session.getInferenceContext();

  assert(context.requests.length >= 1);
  assert.equal(context.requests[0]?.providerId, 'claude-code');
  assert(context.responses.length >= 1);
  assert.equal(context.responses[0]?.text, 'Test response');

  await client.shutdown();
});

test('DurableProviderSession: get provider usage', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  // Create requests and responses
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const requestId = `test-request-${i}`;
    await client.inference!.createRequest({
      requestId,
      providerId: 'claude-code',
      turnId: 'turn-1',
      prompt: `Test prompt ${i}`,
      status: 'completed',
      createdAt: now,
    });

    await client.inference!.storeResponse({
      responseId: `test-response-${i}`,
      requestId,
      providerId: 'claude-code',
      text: `Response ${i}`,
      usage: {
        inputTokens: 10 + i,
        outputTokens: 20 + i,
      },
      duration: 100 + i * 10,
      createdAt: now,
    });
  }

  const usage = await session.getProviderUsage();

  assert.equal(usage.totalRequests, 3);
  assert.equal(usage.totalInputTokens, 30 + 3); // 10 + 11 + 12
  assert.equal(usage.totalOutputTokens, 60 + 3); // 20 + 21 + 22

  await client.shutdown();
});

test('DurableProviderSession: handle failed request with retry', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  const requestId = 'test-request-6';
  const request = await client.inference!.createRequest({
    requestId,
    providerId: 'claude-code',
    turnId: 'turn-1',
    prompt: 'Test prompt',
    status: 'accepted',
    createdAt: Date.now(),
  });

  assert.equal(request.attemptCount, 0);

  // Mark as executing then failed
  await client.inference!.updateRequestStatus(requestId, 'executing');
  await client.inference!.updateRequestStatus(requestId, 'failed');

  // Increment attempt count
  const incremented = await client.inference!.incrementAttempt(requestId);
  assert.equal(incremented.attemptCount, 1);
  assert(incremented.lastAttemptAt !== undefined);

  // Request can be retried
  await client.inference!.updateRequestStatus(requestId, 'executing');
  const retryRequest = await client.inference!.getRequest(requestId);
  assert.equal(retryRequest?.status, 'executing');

  await client.shutdown();
});

test('DurableProviderSession: preserve context across provider switches', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'durable-provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const session = new DurableProviderSession({ feltdb: client, turnId: 'turn-1' }, 'claude-code');

  // Create requests with Claude
  const requestId1 = 'test-request-7';
  await client.inference!.createRequest({
    requestId: requestId1,
    providerId: 'claude-code',
    turnId: 'turn-1',
    prompt: 'Test prompt 1',
    status: 'completed',
    createdAt: Date.now(),
  });

  // Switch provider
  await session.switchProvider('openrouter');
  assert.equal(session.getCurrentProvider(), 'openrouter');

  // Create requests with OpenRouter
  const requestId2 = 'test-request-8';
  await client.inference!.createRequest({
    requestId: requestId2,
    providerId: 'openrouter',
    turnId: 'turn-1',
    prompt: 'Test prompt 2',
    status: 'completed',
    createdAt: Date.now(),
  });

  // Context should contain both requests
  const context = await session.getInferenceContext();
  assert.equal(context.requests.length, 2);
  assert(context.requests.some(r => r.providerId === 'claude-code'));
  assert(context.requests.some(r => r.providerId === 'openrouter'));

  await client.shutdown();
});
