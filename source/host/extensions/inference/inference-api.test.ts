import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { InferenceGatewayAPI } from './inference-api.js';
import type { FeltDBClient } from '../../../packages/feltdb-operations/feltdb-client.js';

// Mock FeltDBClient
const createMockFeltDB = (): FeltDBClient => ({
  initialize: async () => {},
  shutdown: async () => {},
  providerContexts: {
    get: async () => undefined,
    markUsed: async () => {},
  },
  inference: {
    createRequest: async () => ({}),
    updateRequestStatus: async () => {},
    storeResponse: async () => {},
    queryRequestsByStatus: async () => [],
    getRequest: async () => undefined,
  },
} as any);

test('InferenceGatewayAPI: switchProvider updates current provider', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  const result = await api.switchProvider({
    turnId: 'turn-1',
    provider: 'openrouter'
  });

  assert.equal(result.success, true);

  // Verify provider was switched
  const currentProvider = api.getCurrentProvider({ turnId: 'turn-1' });
  assert.equal(currentProvider, 'openrouter');
});

test('InferenceGatewayAPI: switchProvider throws on invalid provider', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  await assert.rejects(
    () => api.switchProvider({ turnId: 'turn-1', provider: 'invalid-provider' }),
    /Invalid provider/
  );
});

test('InferenceGatewayAPI: getCurrentProvider returns current provider', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  const provider = api.getCurrentProvider({ turnId: 'turn-1' });
  assert.equal(provider, 'claude-code'); // Default provider
});

test('InferenceGatewayAPI: executeInference requires turnId', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  await assert.rejects(
    () => api.executeInference({ messages: [] }),
    /Missing required fields/
  );
});

test('InferenceGatewayAPI: executeInference requires messages', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  await assert.rejects(
    () => api.executeInference({ turnId: 'turn-1' }),
    /Missing required fields/
  );
});

test('InferenceGatewayAPI: getInferenceContext returns context', async (t) => {
  const feltdb = createMockFeltDB();
  if (feltdb.inference) {
    feltdb.inference.queryRequestsByStatus = async () => [
      { requestId: 'req-1', status: 'completed' }
    ] as any;
  }

  const api = new InferenceGatewayAPI(feltdb);

  const context = await api.getInferenceContext({ turnId: 'turn-1' });

  assert.equal(context.currentProvider, 'claude-code');
  assert(Array.isArray(context.providers));
  assert(Array.isArray(context.requestHistory));
  assert(Array.isArray(context.responseCache));
});

test('InferenceGatewayAPI: getInferenceContext requires turnId', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  await assert.rejects(
    () => api.getInferenceContext({}),
    /Missing required field/
  );
});

test('InferenceGatewayAPI: multiple sessions are isolated', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  // Switch provider in one turn
  await api.switchProvider({ turnId: 'turn-1', provider: 'openrouter' });

  // Other turn should have default provider
  const provider1 = api.getCurrentProvider({ turnId: 'turn-1' });
  const provider2 = api.getCurrentProvider({ turnId: 'turn-2' });

  assert.equal(provider1, 'openrouter');
  assert.equal(provider2, 'claude-code');
});

test('InferenceGatewayAPI: switchProvider with valid providers', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  const providers = ['claude-code', 'codex', 'openrouter'];

  for (const provider of providers) {
    const result = await api.switchProvider({
      turnId: 'turn-1',
      provider
    });
    assert.equal(result.success, true);
    assert.equal(api.getCurrentProvider({ turnId: 'turn-1' }), provider);
  }
});

test('InferenceGatewayAPI: getProviderUsage requires turnId', async (t) => {
  const feltdb = createMockFeltDB();
  const api = new InferenceGatewayAPI(feltdb);

  await assert.rejects(
    () => api.getProviderUsage({}),
    /Missing required field/
  );
});
