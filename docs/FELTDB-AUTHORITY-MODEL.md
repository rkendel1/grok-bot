# FeltDB Authority Model - Implemented Architecture

FeltDB is the **primary durable state layer** for Grok Bot. All critical state flows through FeltDB collections with strict authority semantics.

## Current Architecture (Phases 1-3.3)

### Data Organization

```
Host Process
└── HostFeltDBRuntime (lifecycle management)
    └── FeltDB Instance
        ├── Phase 1: Tool Execution (Exactly-Once)
        │   ├── operations (durable work units)
        │   ├── executions (cached results)
        │   └── recovery_checkpoints (replay markers)
        │
        ├── Phase 2: Coordinator (Routing State)
        │   └── coordinator_operations (streaming state)
        │
        └── Phase 3: Provider Management (Context Preservation)
            ├── provider_contexts (credentials, settings)
            ├── inference_requests (request tracking)
            └── inference_responses (response cache)
```

### Authority Semantics

**FeltDB is the single source of truth** for:
- Tool execution state (exact-once guarantee)
- Coordinator routing operations (durable message log)
- Provider credentials and settings
- Inference request lifecycle and response cache

**Authority Properties:**
- **Blocking Writes**: All writes are synchronous (`await`)
- **Atomic Transitions**: Immutable aggregates with version tracking
- **Idempotent Operations**: SHA-256 content hashing prevents duplicates
- **Persistent**: Survives process crashes (recovery on startup)

### Crash Recovery Protocol

On host process startup:

```
1. HostFeltDBRuntime.initialize() called
   ↓
2. FeltDB instance created and loaded
   ↓
3. recoverOnStartup() identifies pending operations:
   - Phase 1: Tool executions (accepted/executing)
   - Phase 2: Coordinator operations (accepted/in_flight)
   - Phase 3: Inference requests (accepted/executing)
   ↓
4. For each pending operation:
   - Check for cached result
   - If cached: mark completed (no re-execution)
   - If not cached: mark for retry
   ↓
5. Resume normal operation with full history intact
```

**Guarantee:** No tool executions are lost or duplicated.

## Phase 3: Provider Switching Architecture

### DurableProviderSession

Wraps provider inference with FeltDB durability:

```
User Message
    ↓
DurableProviderSession.executeInferenceDurable()
    ├─ 1. Create InferenceRequest (await FeltDB write)
    ├─ 2. Update status → executing (await FeltDB write)
    ├─ 3. Call provider API (can crash here)
    ├─ 4. Cache response (await FeltDB write)
    ├─ 5. Update status → completed (await FeltDB write)
    ↓
Return to user
```

**On Crash During Step 3:**
```
App Restart
    ↓
HostFeltDBRuntime.initialize()
    ↓
Find pending InferenceRequest
    ├─ Has cached response? → Return cached (no re-execution)
    └─ No cache? → Mark for retry
    ↓
Resume conversation
```

### Provider Switching

```
Current Provider: Claude
    ↓
User action: switchProvider('openai')
    ↓
DurableProviderSession.switchProvider('openai')
    ├─ Update currentProvider
    └─ Mark provider as used (lastUsedAt timestamp)
    ↓
Next inference uses OpenAI
    ↓
Turn history preserved: ✓
  - All previous requests/responses available
  - Provider context (credentials, settings) recovered
  - Conversation continues seamlessly
```

## Version Transitions

All entities use immutable aggregates with explicit version changes:

### InferenceRequest Lifecycle

```
status: 'accepted', version: 1
    ↓ updateRequestStatus('executing')
status: 'executing', version: 2, executedAt: timestamp
    ↓ (provider call succeeds)
status: 'completed', version: 3, completedAt: timestamp

OR

status: 'accepted', version: 1
    ↓ updateRequestStatus('executing')
status: 'executing', version: 2, executedAt: timestamp
    ↓ (provider call fails)
status: 'failed', version: 3
    ↓ incrementAttempt()
attemptCount: 1, version: 4, lastAttemptAt: timestamp
```

### ProviderContext Updates

```
settings: {...}, version: 1
    ↓ updateSettings({ temperature: 0.9 })
settings: {..., temperature: 0.9}, version: 2, lastUsedAt: timestamp
    ↓ updateCredentials({ apiKey: 'new-key' })
credentials: { apiKey: 'new-key' }, version: 3
```

## Consistency Guarantees

### Exactly-Once Semantics

1. **Idempotency via Content Hash**
   ```
   SHA-256(operationId + inputs) → unique operation ID
   Duplicate inputs → same operation ID → no re-execution
   ```

2. **Cached Results**
   ```
   Tool execution recorded → result cached in FeltDB
   Crash before response sent → recovers and uses cached result
   No provider re-call needed
   ```

3. **Atomic Updates**
   ```
   Phase 1: Create InferenceRequest (await)
   Phase 2: Call provider (unprotected, can crash)
   Phase 3: Cache result (await)
   Phase 4: Mark completed (await)
   
   Recovery finds incomplete requests → skips to step 3 with cache
   ```

### Frontier-Based Recovery

Checkpoints mark "all operations up to point X processed":

```
Start:   Operations 1-100 pending
  ↓
Process Operations 1-50
  ↓
Create Checkpoint at operation 50
  ↓
Crash, restart
  ↓
Read Checkpoint → skip operations 1-50
  ↓
Process Operations 51-100 (only)
  ↓
No duplicate work
```

## Testing Coverage

**93+ Tests across phases:**
- Phase 1: 40+ tests (tool execution recovery)
- Phase 2: 12+ tests (coordinator durability)
- Phase 3.1: 24+ tests (provider context, inference store)
- Phase 3.2: 9+ tests (durable provider session)
- Phase 3.3: 12+ tests (host FeltDB runtime)

**Test Categories:**
- Unit: Individual store CRUD operations
- Integration: Multi-store transactions
- Recovery: Crash-restart scenarios
- Provider: Switching and context preservation

## Phase 3.4: Gateway API (Implemented)

REST endpoints for provider switching and inference execution:

```
POST /api/inference/switch-provider
  ├─ Input: { turnId, provider }
  ├─ Per-turn session isolation
  └─ Response: { success: boolean }

POST /api/inference/execute
  ├─ Input: { turnId, messages, providerId?, options? }
  ├─ Creates InferenceRequest in FeltDB
  ├─ Executes with durable tracking
  ├─ Caches response automatically
  └─ Response: { text, usage, provider }

GET /api/inference/context
  ├─ Input: { turnId }
  ├─ Queries FeltDB for full history
  └─ Response: { currentProvider, providers, requestHistory, responseCache }
```

**Architecture:**
- InferenceGatewayAPI per-turn sessions
- Each session wraps DurableProviderSession
- Automatic session creation and lifecycle
- FeltDB as persistent backend

## Future Phases

### Phase 3.5: macOS App Packaging

Bundle FeltDB with app:
- @feltdb/core in app.asar.unpacked
- Data persists in ~/.../Grok Bot/.feltdb/
- Zero external dependencies
- Time Machine backups supported

## Design Rationale

**Why FeltDB?**
- State-first semantics (not traditional CRUD)
- Blocking writes guarantee no data loss
- Atomic version transitions prevent conflicts
- Idempotency built into design
- No duplicate execution on replay
- Collections provide structure without SQL

**Why Host Process Lifecycle?**
- FeltDB instance lives for app lifetime
- Single source of truth per app instance
- Automatic recovery on every startup
- No external database service needed
- App shutdown cleanly closes FeltDB

**Why Authority Semantics?**
- All critical writes are blocking (await)
- Failures propagate immediately
- No fire-and-forget operations
- Ensures data integrity under crashes
- Matches Grok Bot's needs (availability > availability)

## Migration Notes

This is a **complete replacement** for prior coordination mechanisms:
- ✓ Tool execution tracking (was in-memory, now durable)
- ✓ Coordinator state (was transient, now durable)
- ✓ Provider context (new capability)
- ✓ Inference caching (new capability)

All existing crash recovery logic now routes through FeltDB.
