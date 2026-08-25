# FeltDB Gateway API - Phase 3.4

**Status:** Implemented  
**Location:** `source/host/extensions/inference/inference-api.ts`

## Overview

The Gateway API exposes provider switching and durable inference execution through REST endpoints, enabling seamless multi-provider support with full context preservation.

## Architecture

```
Client Request
    ↓
Host Gateway API (host-gateway-api.ts)
    ├─ switchInferenceProvider()
    ├─ executeInference()
    ├─ getInferenceContext()
    ├─ getProviderUsage()
    └─ getCurrentInferenceProvider()
    ↓
InferenceGatewayAPI (inference-api.ts)
    ├─ Per-turn session management (Map<turnId, DurableProviderSession>)
    ├─ Session lifecycle (lazy creation)
    └─ FeltDB integration
    ↓
DurableProviderSession
    ├─ Provider switching
    ├─ Durable inference execution
    ├─ Response caching
    └─ Context preservation
    ↓
FeltDB Collections
    ├─ providerContexts (provider state)
    ├─ inferenceRequests (request tracking)
    └─ inferenceResponses (response cache)
```

## REST Endpoints

### 1. Switch Provider

**Endpoint:** `POST /api/inference/switch-provider`

**Request:**
```json
{
  "turnId": "turn-123",
  "provider": "openrouter"
}
```

**Response:**
```json
{
  "success": true
}
```

**Behavior:**
- Changes active provider for the specified turn
- Preserves all prior context and request history
- Marks new provider as used in FeltDB
- Idempotent: switching to same provider is safe

**Valid Providers:**
- `claude-code` (default)
- `codex`
- `openrouter`

### 2. Execute Inference

**Endpoint:** `POST /api/inference/execute`

**Request:**
```json
{
  "turnId": "turn-123",
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi!" }
  ],
  "providerId": "openrouter",
  "options": {
    "temperature": 0.7,
    "maxTokens": 1024
  }
}
```

**Response:**
```json
{
  "text": "Generated response",
  "usage": {
    "inputTokens": 50,
    "outputTokens": 100,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0
  },
  "provider": "openrouter"
}
```

**Durable Execution Flow:**
```
1. Create InferenceRequest (await FeltDB write)
   └─ status: 'accepted'
   
2. Update status → 'executing' (await FeltDB write)
   
3. Check response cache
   ├─ If cached: return cached (no provider call)
   └─ If not cached: continue
   
4. Call provider API
   └─ Can crash here (recovery point)
   
5. Cache response (await FeltDB write)
   
6. Update status → 'completed' (await FeltDB write)
   
7. Return to client
```

**On Crash During Step 4:**
```
App Restart
    ↓
HostFeltDBRuntime.initialize()
    ↓
recoverOnStartup() identifies pending requests
    ├─ InferenceRequest status='executing'
    ├─ Check for cached response
    ├─ If cached: mark completed (no re-execution)
    └─ If not cached: mark for retry
    ↓
Client can retry or query context
```

### 3. Get Inference Context

**Endpoint:** `GET /api/inference/context`

**Request:**
```json
{
  "turnId": "turn-123"
}
```

**Response:**
```json
{
  "currentProvider": "openrouter",
  "providers": [
    {
      "providerId": "claude-code",
      "kind": "claude-code",
      "settings": { "model": "claude-opus" },
      "lastUsedAt": 1693491200000
    },
    {
      "providerId": "openrouter",
      "kind": "openrouter",
      "settings": { "model": "meta-llama/llama-2-70b" },
      "lastUsedAt": 1693491300000
    }
  ],
  "requestHistory": [
    {
      "requestId": "req-1",
      "providerId": "claude-code",
      "status": "completed",
      "createdAt": 1693491200000
    },
    {
      "requestId": "req-2",
      "providerId": "openrouter",
      "status": "completed",
      "createdAt": 1693491250000
    }
  ],
  "responseCache": [
    {
      "responseId": "resp-1",
      "requestId": "req-1",
      "text": "First response",
      "duration": 1234
    },
    {
      "responseId": "resp-2",
      "requestId": "req-2",
      "text": "Second response",
      "duration": 1567
    }
  ]
}
```

**Usage:** 
- Query full inference history for a turn
- See all providers used and their context
- Access cached responses for all previous requests
- No FeltDB writes, read-only operation

### 4. Get Provider Usage

**Endpoint:** `GET /api/inference/provider-usage`

**Request:**
```json
{
  "turnId": "turn-123"
}
```

**Response:**
```json
{
  "totalRequests": 5,
  "totalInputTokens": 1200,
  "totalOutputTokens": 2400,
  "averageLatencyMs": 1245,
  "byProvider": {
    "claude-code": {
      "requests": 3,
      "inputTokens": 700,
      "outputTokens": 1400,
      "averageLatencyMs": 1100
    },
    "openrouter": {
      "requests": 2,
      "inputTokens": 500,
      "outputTokens": 1000,
      "averageLatencyMs": 1500
    }
  }
}
```

## Session Isolation

Each turn gets a dedicated DurableProviderSession:

```typescript
const session = this.sessions.get(turnId);
// Or auto-create if missing
```

**Benefits:**
- Turn-isolated provider state
- No cross-turn contamination
- Independent recovery on startup
- Efficient memory cleanup when turn completes

**Lifecycle:**
```
Client call with turnId
    ↓
Check sessions map for turnId
    ├─ If exists: use existing session
    └─ If not exists: create new (DurableProviderSession)
    ↓
Session persists in memory for turn lifetime
    ↓
Manual cleanup or automatic GC when turn ends
```

## Error Handling

### Missing Turn ID
```
Request: {}
Response: HTTP 400
{
  "error": "Missing required field: turnId"
}
```

### Invalid Provider
```
Request: { "turnId": "turn-1", "provider": "invalid" }
Response: HTTP 400
{
  "error": "Invalid provider: invalid. Valid providers: claude-code, codex, openrouter"
}
```

### Missing Messages
```
Request: { "turnId": "turn-1" }
Response: HTTP 400
{
  "error": "Missing required fields: turnId, messages"
}
```

### FeltDB Unavailable
```
Response: HTTP 500
{
  "error": "InferenceGatewayAPI not available - FeltDB not initialized"
}
```

## Integration with HostFeltDBRuntime

The InferenceGatewayAPI requires FeltDB to be initialized:

```typescript
// In host startup
const hostRuntime = new HostFeltDBRuntime({ sandRootDir });
const feltdb = await hostRuntime.initialize();

// FeltDB passed to inference extension
// InferenceGatewayAPI created if FeltDB available
```

If FeltDB is not available, the API methods throw `"InferenceGatewayAPI not available"` error.

## Consistency Guarantees

### Exactly-Once Execution
```
Request arrives twice with same content
    ↓
SHA-256 hash of (turnId + provider + messages) → unique ID
    ↓
If ID already in FeltDB: return cached result (no re-execution)
```

### Atomic Transitions
```
All FeltDB writes are blocking (await)
    ├─ createRequest (blocking)
    ├─ updateStatus (blocking)
    ├─ storeResponse (blocking)
    └─ All or nothing: no partial updates
```

### Provider-agnostic Durability
```
Inference with Provider A
    ├─ Request tracked in FeltDB
    ├─ Crash before response cached
    ↓
App restart, recovery finds pending request
    ├─ Provider A context recovered
    ├─ Retry OR use cached result
    └─ Continue seamlessly
    ↓
Switch to Provider B mid-turn
    ├─ All Provider A context preserved
    ├─ New Provider B context created
    ├─ Full history available
    └─ No data loss
```

## Performance Characteristics

### Per-Request Overhead
- FeltDB writes (create, update, store): ~10-50ms per FeltDB operation
- Session lookup (Map): O(1)
- Provider call: varies (typically 500-5000ms)

### Memory Usage
- Per-turn session: ~1KB base + message history
- Session map for 100 turns: ~100KB
- Response cache: varies with number of requests

### Scalability
- Per-turn isolation: linear memory growth with active turns
- FeltDB persistence: disk-bound, not memory-limited
- Recovery on startup: linear scan of pending operations (optimized with recovery_checkpoints)

## Testing

**9 Tests in inference-api.test.ts:**
- Provider switching validation
- Invalid provider rejection
- Per-turn session isolation
- Context retrieval with history
- Error handling for missing fields
- Multiple sessions independence
- All valid provider support
- Usage analytics

**Integration Points:**
- DurableProviderSession unit tests (10+ tests)
- HostFeltDBRuntime integration (12+ tests)
- E2E with real providers (TODO: Phase 3.5)

## Future Enhancements

### Phase 3.5
- [ ] Packaging FeltDB with desktop app
- [ ] Provider health monitoring
- [ ] Automatic failover on provider errors

### Phase 4
- [ ] Cross-device provider sync
- [ ] Provider pools and load balancing
- [ ] Fine-tuning context per provider
- [ ] Multi-modal provider support
- [ ] Cost optimization and tracking

## Code Organization

```
source/host/extensions/inference/
├── inference-api.ts (220 LOC)
│   └─ InferenceGatewayAPI class
├── inference-api.test.ts (150 LOC)
│   └─ 9 test cases
├── durable-provider-session.ts (230 LOC)
│   └─ DurableProviderSession wrapper
└── production.ts (50 LOC)
    └─ Gateway API initialization

source/host/
└── host-gateway-api.ts (50 LOC delta)
    └─ Gateway endpoint routing
```

**Total Phase 3.4 LOC:** ~320 LOC (code + tests)

---

**Dependencies:** Phase 3.1 (ProviderContextStore), Phase 3.2 (DurableProviderSession), Phase 3.3 (HostFeltDBRuntime)

**Next:** Phase 3.5 - macOS app packaging with bundled FeltDB
