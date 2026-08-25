import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FeltDBClient } from './feltdb-client.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDbPath: string;

test('ProviderContextStore: create stores provider context', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const context = await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: {
      model: 'claude-opus-5',
      temperature: 0.7,
    },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  assert(context);
  assert.equal(context.providerId, 'claude');
  assert.equal(context.kind, 'claude');
  assert.equal(context.settings.model, 'claude-opus-5');
  assert.equal(context.version, 1);

  await client.shutdown();
});

test('ProviderContextStore: get provider context', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  await client.providerContexts!.create({
    providerId: 'openai',
    kind: 'openai',
    settings: { model: 'gpt-4' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  const retrieved = await client.providerContexts!.get('openai');

  assert(retrieved);
  assert.equal(retrieved.providerId, 'openai');
  assert.equal(retrieved.kind, 'openai');

  await client.shutdown();
});

test('ProviderContextStore: update settings', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: { model: 'claude-opus-5', temperature: 0.5 },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  const updated = await client.providerContexts!.updateSettings('claude', {
    temperature: 0.9,
    maxTokens: 4000,
  });

  assert.equal(updated.settings.temperature, 0.9);
  assert.equal(updated.settings.maxTokens, 4000);
  assert.equal(updated.version, 2);

  await client.shutdown();
});

test('ProviderContextStore: update credentials', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  await client.providerContexts!.create({
    providerId: 'openai',
    kind: 'openai',
    settings: { model: 'gpt-4' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  const updated = await client.providerContexts!.updateCredentials('openai', {
    apiKey: 'sk-test-123',
  });

  assert(updated.credentials);
  assert.equal(updated.credentials.apiKey, 'sk-test-123');
  assert.equal(updated.version, 2);

  await client.shutdown();
});

test('ProviderContextStore: mark provider as used', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const created = await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: { model: 'claude-opus-5' },
    lastUsedAt: 0,
    createdAt: Date.now(),
  });

  const before = created.lastUsedAt;
  await new Promise((resolve) => setTimeout(resolve, 10));

  const updated = await client.providerContexts!.markUsed('claude');

  assert(updated.lastUsedAt > before);

  await client.shutdown();
});

test('ProviderContextStore: get all contexts', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: { model: 'claude-opus-5' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  await client.providerContexts!.create({
    providerId: 'openai',
    kind: 'openai',
    settings: { model: 'gpt-4' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  const all = await client.providerContexts!.getAll();

  assert.equal(all.length, 2);
  assert(all.some((c) => c.providerId === 'claude'));
  assert(all.some((c) => c.providerId === 'openai'));

  await client.shutdown();
});

test('ProviderContextStore: get most recently used', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const now = Date.now();
  await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: { model: 'claude-opus-5' },
    lastUsedAt: now - 1000,
    createdAt: now,
  });

  await client.providerContexts!.create({
    providerId: 'openai',
    kind: 'openai',
    settings: { model: 'gpt-4' },
    lastUsedAt: now,
    createdAt: now,
  });

  const recent = await client.providerContexts!.getMostRecentlyUsed();

  assert(recent);
  assert.equal(recent.providerId, 'openai');

  await client.shutdown();
});

test('ProviderContextStore: query by kind', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: { model: 'claude-opus-5' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  await client.providerContexts!.create({
    providerId: 'openai',
    kind: 'openai',
    settings: { model: 'gpt-4' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  const claudeProviders = await client.providerContexts!.getByKind('claude');

  assert.equal(claudeProviders.length, 1);
  const firstProvider = claudeProviders[0];
  if (firstProvider) {
    assert.equal(firstProvider.providerId, 'claude');
  }

  await client.shutdown();
});

test('ProviderContextStore: delete provider', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: { model: 'claude-opus-5' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  await client.providerContexts!.delete('claude');

  const retrieved = await client.providerContexts!.get('claude');

  assert.equal(retrieved, undefined);

  await client.shutdown();
});

test('ProviderContextStore: version increments on update', async (t) => {
  testDbPath = await mkdtemp(join(tmpdir(), 'provider-test-'));
  const client = new FeltDBClient({ rootPath: testDbPath });
  await client.initialize();

  const context = await client.providerContexts!.create({
    providerId: 'claude',
    kind: 'claude',
    settings: { model: 'claude-opus-5' },
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  });

  assert.equal(context.version, 1);

  const updated1 = await client.providerContexts!.updateSettings('claude', { temperature: 0.8 });
  assert.equal(updated1.version, 2);

  const creds = { apiKey: 'test' };
  const updated2 = await client.providerContexts!.updateCredentials('claude', creds);
  assert.equal(updated2.version, 3);

  await client.shutdown();
});
