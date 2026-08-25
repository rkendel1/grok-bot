# FeltDB Phase 3 - Provider Context Management & App Integration

**Status:** Planning  
**Target:** Provider switching with context preservation, FeltDB self-hosting, macOS app packaging

## Overview

Extend FeltDB durability to provider management, enabling:
- Switch providers (Claude, OpenAI, etc.) mid-conversation
- Preserve inference context across provider switches
- Store provider credentials and settings durably
- Self-host FeltDB in the desktop app
- Bundle FeltDB with macOS app as single portable unit

## Architecture

```
Desktop App (Electron)
├── HostFeltDBRuntime (manages FeltDB lifecycle)
│   │
│   └── FeltDB Collections
│       ├── provider_contexts (Phase 3.1)
│       │   ├── providerId (uuid)
│       │   ├── credentials (API keys, tokens - encrypted)
│       │   ├── settings (model, temperature, max tokens)
│       │   └── lastUsedAt (for tracking)
│       │
│       ├── inference_requests (Phase 3.2)
│       │   ├── requestId (uuid)
│       │   ├── providerId
│       │   ├── turnId
│       │   ├── prompt (durable)
│       │   └── status (accepted → executing → completed/cached/failed)
│       │
│       ├── inference_responses (Phase 3.2)
│       │   ├── responseId (uuid)
│       │   ├── requestId
│       │   ├── text (cached result)
│       │   └── usage (tokens, latency)
│       │
│       ├── operations (Phase 1)
│       ├── executions (Phase 1)
│       ├── coordinator_operations (Phase 2)
│       └── recovery_checkpoints (Phase 1)
│
├── DurableProviderSession
│   └── Uses FeltDB collections for durable inference
│
└── Gateway Server
    └── Routes provider calls through durable session
```

## Implementation Phases

### Phase 3.1: Provider Context Store

**Location:** `source/packages/feltdb-operations/provider-context-store.ts`

Store provider state durably:
```typescript
interface ProviderContext {
  providerId: string;
  kind: 'claude' | 'openai' | 'openrouter' | 'custom';
  credentials?: {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
  };
  settings: {
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  lastUsedAt: number;
  createdAt: number;
  version: number;
}

interface InferenceRequest {
  requestId: string;
  providerId: string;
  turnId: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: number;
  executedAt?: number;
  completedAt?: number;
}

interface InferenceResponse {
  responseId: string;
  requestId: string;
  providerId: string;
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  duration: number;
  createdAt: number;
}
```

### Phase 3.2: Provider Session with Durability

**Location:** `source/host/extensions/inference/durable-provider-session.ts`

Wrap existing provider session with FeltDB durability:
```typescript
class DurableProviderSession {
  async executeWithProvider(
    provider: RoutedProvider,
    messages: CoreMessage[],
    tools?: ToolSet
  ): Promise<{text: string; usage: UsageRecord}> {
    // 1. Store inference request durably
    const request = await feltdb.inferenceRequests.create({
      requestId: randomUUID(),
      providerId: provider,
      turnId: currentTurn,
      prompt: JSON.stringify(messages),
      status: 'accepted'
    });

    // 2. Check cache first
    const cached = await feltdb.inferenceResponses.getByRequest(request.requestId);
    if (cached) return cached.response;

    // 3. Execute with actual provider (can crash here)
    try {
      const result = await executeProvider(provider, messages, tools);
      
      // 4. Store response durably
      await feltdb.inferenceResponses.create({
        responseId: randomUUID(),
        requestId: request.requestId,
        providerId: provider,
        text: result.text,
        usage: result.usage,
        duration: Date.now() - startTime,
        createdAt: Date.now()
      });

      // 5. Update request status
      await feltdb.inferenceRequests.updateStatus(request.requestId, 'completed');
      
      return result;
    } catch (err) {
      await feltdb.inferenceRequests.updateStatus(request.requestId, 'failed');
      throw err;
    }
  }

  async switchProvider(newProvider: RoutedProvider): Promise<void> {
    // Save current provider context
    await feltdb.providerContexts.update(currentProvider, {
      lastUsedAt: Date.now()
    });

    // Load new provider context
    const context = await feltdb.providerContexts.get(newProvider);
    if (!context) {
      // Create new provider context if switching for first time
      await feltdb.providerContexts.create({
        providerId: newProvider,
        kind: newProvider,
        settings: { model: defaultModel(newProvider) },
        createdAt: Date.now()
      });
    }
    
    currentProvider = newProvider;
  }

  async recoverPendingRequests(): Promise<void> {
    const pending = await feltdb.inferenceRequests.queryByStatus('pending', 'executing');
    for (const req of pending) {
      // Check if response already cached
      const response = await feltdb.inferenceResponses.getByRequest(req.requestId);
      if (response) {
        await feltdb.inferenceRequests.updateStatus(req.requestId, 'completed');
        // Use cached response
      } else {
        // Retry or mark as failed based on attempt count
        if (req.attemptCount >= MAX_RETRIES) {
          await feltdb.inferenceRequests.updateStatus(req.requestId, 'failed');
        } else {
          await feltdb.inferenceRequests.incrementAttempt(req.requestId);
        }
      }
    }
  }
}
```

### Phase 3.3: FeltDB Host Integration

**Location:** `source/host/host-feltdb-runtime.ts`

Initialize and manage FeltDB in host process:
```typescript
class HostFeltDBRuntime {
  private feltdb: FeltDBClient;
  private path: string;

  async initialize(sandRootDir: string): Promise<void> {
    this.path = join(sandRootDir, '.feltdb');
    
    this.feltdb = new FeltDBClient({
      rootPath: this.path,
      namespace: 'grok-bot-host',
      enabled: true
    });

    await this.feltdb.initialize();

    // Initialize stores
    await this.feltdb.checkpoints.getLatestForProcess(process.pid.toString());
    
    // Run recovery on startup
    const recovery = new RecoverySystem(this.feltdb);
    await recovery.initialize();

    console.log(`FeltDB initialized at ${this.path}`);
  }

  async shutdown(): Promise<void> {
    await this.feltdb.shutdown();
  }

  getFeltDB(): FeltDBClient {
    return this.feltdb;
  }
}
```

### Phase 3.4: Inference Store

**Location:** `source/packages/feltdb-operations/inference-store.ts`

Track inference requests and responses:
```typescript
class InferenceStore {
  // Create request durably
  async create(request: InferenceRequest): Promise<InferenceRequest>;
  
  // Get by ID
  async get(requestId: string): Promise<InferenceRequest | undefined>;
  
  // Query by status
  async queryByStatus(...statuses: string[]): Promise<InferenceRequest[]>;
  
  // Update status atomically
  async updateStatus(requestId: string, status: string): Promise<void>;
  
  // Increment attempt count
  async incrementAttempt(requestId: string): Promise<void>;
  
  // Query response cache
  async getResponse(requestId: string): Promise<InferenceResponse | undefined>;
  
  // Store response
  async storeResponse(response: InferenceResponse): Promise<void>;
  
  // Query usage for analytics
  async queryUsage(provider: string, timeRange: {start: number; end: number}): Promise<{
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    averageLatencyMs: number;
  }>;
}
```

### Phase 3.5: Packaging with FeltDB

Update macOS packaging to include FeltDB:

1. **Build Process**
   - @feltdb/core bundled in app.asar.unpacked
   - FeltDB dependencies included
   - Native bindings compiled for macOS

2. **Data Directory**
   - FeltDB stores in `~/Library/Application Support/Grok Bot/.feltdb/`
   - Persists across app versions
   - Backed up by Time Machine

3. **Initialization**
   - Check FeltDB on app startup
   - Migrate if schema changes
   - Run recovery protocol

## Implementation Tasks

### Must Do (MVP)
- [ ] ProviderContextStore CRUD
- [ ] ProviderStore tests
- [ ] InferenceStore with caching
- [ ] DurableProviderSession wrapper
- [ ] FeltDB host initialization
- [ ] Provider switching logic
- [ ] Packaging update

### Nice to Have
- [ ] Usage analytics dashboard
- [ ] Provider cost tracking
- [ ] Context sharing between turns
- [ ] Provider health monitoring
- [ ] Automatic failover on provider errors

### Future (Phase 4+)
- [ ] Cross-device provider sync
- [ ] Provider pools/load balancing
- [ ] Provider-specific RAG
- [ ] Fine-tuning context
- [ ] Multi-modal providers

## API Changes

### Gateway API
```
POST /api/inference/switch-provider
  body: { provider: 'claude' | 'openai' | ... }
  response: { success: true }

POST /api/inference/execute
  body: { messages: CoreMessage[]; provider: 'current' | 'specific' }
  response: { text: string; usage: UsageRecord }

GET /api/inference/context
  response: {
    currentProvider: string;
    providers: ProviderContext[];
    requestHistory: InferenceRequest[];
  }
```

### Settings Update
- Provider credentials → FeltDB
- Model selection → FeltDB
- Inference history → FeltDB
- Usage analytics → FeltDB

## Benefits

✓ **Durability**: Inference requests/responses survive crashes
✓ **Context Preservation**: Switch providers without losing context
✓ **Offline Support**: Execute cached responses without network
✓ **Analytics**: Track usage across providers durably
✓ **Recovery**: Automatic retry of failed requests
✓ **Portability**: Single packaged app with all data

## Timeline

- **Phase 3.1**: Provider stores (2-3 days)
- **Phase 3.2**: Durable session wrapper (1-2 days)
- **Phase 3.3**: Host integration (1 day)
- **Phase 3.4**: Packaging (1 day)
- **Total**: 5-7 days

## Next Steps

1. Create ProviderContextStore with full test coverage
2. Implement InferenceStore for request/response caching
3. Wrap ProviderSession with DurableProviderSession
4. Initialize FeltDB in host process startup
5. Test provider switching mid-conversation
6. Update macOS packaging to include FeltDB
7. End-to-end testing with real provider switches

---

**Dependencies:** Phase 1 (OperationStore), Phase 2 (CoordinatorOperationStore)
**Affects:** Desktop app startup, provider switching, inference execution
**Risk:** Medium (new data store, provider integration, packaging)
