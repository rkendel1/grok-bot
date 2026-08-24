# FeltDB as Authority Substrate: Evaluation v2

**Status:** Architecture Discovery—Authority Boundary Design  
**Scope:** Grok Bot 0.18 Reconstructed  
**Objective:** Determine whether FeltDB can provide cross-process durable authority for coordination, with SQLite retained for session-local transcript data

## Executive Summary

Grok Bot 0.18 Reconstructed has multiple process boundaries (Electron main, host, coordinator) and currently manages application authority in fragmented ways:

- **Session/Transcript:** SQLite per-session (session-local authority, not cross-process)
- **Coordinator State:** Process-memory only (no durability across restart)
- **Execution State:** Partial durability (durable markers exist, but ephemeral runtime state)
- **Idempotency/Deduplication:** Not tracked durably (tool execution may duplicate)
- **Cross-Process Coordination:** No unified authority layer

### The Central Question

**Can FeltDB provide a unified durable authority boundary that allows multiple processes to safely coordinate turns, executions, and recovery without abandoning SQLite for session data?**

### Recommendation

**ADOPT AS AUTHORITY SUBSTRATE—with SQLite as specialized local layer**

FeltDB should own:
- Durable operation identity and lifecycle
- Idempotency and deduplication keys
- Execution state transitions
- Recovery checkpoints
- Cross-process coordination facts

SQLite should continue to own (by design):
- Transcript and conversation content
- Session-local turn data
- Blob-heavy conversation state

This is a **unifying architecture**, not an overlay. FeltDB is the substrate; SQLite is a specialized projection for local session data.

The proof-of-concept will be **execution recovery**: prevent duplicate tool execution across process restarts.

## Architecture Overview

```
Renderer (React)
    │
    ▼
Electron Preload (RPC Bridge)
    │
    ▼
Electron Main
  ├─ Settings (JSON files)
  ├─ Secrets/Auth
  ├─ Coordinator (child process, message port)
  └─ Box Connectors (remote/local Docker)
    │
    ▼
Coordinator Process
  ├─ Transcript Routing
  ├─ Streaming Activity
  └─ Routed MCP Bridge
    │
    ▼
Host (Inference & Tools)
  ├─ Turn Execution
  ├─ MCP/Tools
  ├─ Provider Routing
  └─ Settings/State
    │
    ▼
Inference Routers
  ├─ Cursor / Claude Code / Codex / OpenRouter
  └─ Tool Execution
```

## State Classification Framework

Every state item is labeled:

- **A: Durable Authority** — Authoritative source survives process death; reads/writes go here first
- **B: Durable Projection** — Persistent (survives crash) but explicitly reconstructible from another authority
- **C: Ephemeral Runtime** — Lost on crash; intentionally reconstructed on restart
- **D: Unknown** — Not yet established from code inspection

This prevents conflating "stored somewhere" with "authoritative."

---

## Current State Inventory & Authority Analysis

### 1. Settings & Configuration

**Classification:** A (Durable Authority, currently JSON)  
**Storage:** `SandSettingsStore` (atomic file writes via temp+rename)  
**State Owner:** Electron main process (exclusive writer)  
**Current Durability:** Full (filesystem)  
**Multi-writer Scenario:** No (single process)  
**Includes:**
- Theme preferences
- Update track selection
- MCP server configuration
- Auto-review instructions
- Inference provider selection
- Box runtime choice (remote vs. local Docker)
- Timezone overrides
- Agent model selection

**Authority Question:** Should settings authority remain with Electron main (via JSON), or move to FeltDB for cross-process visibility?

**Decision:** Keep as-is for v1. Electron main remains settings authority. Host/coordinator read via RPC if they need settings (rare). Rationale: Settings are low-churn, rarely conflict, and Electron-main-as-coordinator is acceptable for this domain.

### 2. Session & Conversation Lifecycle

**CRITICAL CONTRADICTION RESOLVED:**

Previous documents said "SQLite is authority" but also "Session identity in-memory" and "Turns are partial."

**Truth established from code audit:**

| Item | Classification | Authority | Durability |
|------|---|---|---|
| Session identity (agentId) | **A** (Durable Authority) | SQLite agent.db + JSON pointer | Full |
| Conversation transcript | **A** (Durable Authority) | SQLite agent.db | Full (WAL) |
| Turn state (seq, markers) | **A** (Durable Authority) | SQLite transcript_entries | Full |
| KV metadata store | **A** (Durable Authority) | SQLite agent.db | Full |
| Ack obligations | **A** (Durable Authority) | Durable marker (JSON file) | Full |
| Pending wakes | **A** (Durable Authority) | sand-pending-wake.json | Full |

**Current Storage:** SQLite per-session (`{agentId}/agent.db`)  
**State Owner:** Host process (exclusive handle per session via `liveDbHandleCount()`)  
**Crash Recovery:** WAL replay on next open; durable markers re-arm on restart  
**Multi-Process Access:** No (single host process, exclusive per-session)

**FeltDB Role (Proposed):**

FeltDB should NOT replace SQLite for session data. Instead:

1. **FeltDB owns: Turn/execution identity across process boundaries**
   - Turn identity (TurnID) known to multiple processes
   - Execution state queryable from host, coordinator, recovery
   - Idempotency keys visible to multiple processes

2. **SQLite owns: Session-local turn content**
   - Actual transcript entries
   - Message content
   - Conversation state blobs
   - Remain session-scoped, optimized for single-session queries

**Decision:** This is a **layering**, not a replacement.

```
FeltDB: Turn identity, lifecycle, idempotency
   ↓
Host process
   ↓
SQLite: Turn content (local session DB)
```

### 3. Turn Execution State & Idempotency

**THE REAL AUTHORITY GAP:**

Current state management does NOT prevent duplicate tool execution across process restarts.

Current flow:
```
Accept turn
  ↓
Durable marker written (ack obligations, pending wakes)
  ↓
Host process executes turn + tools
  ↓
Process crashes DURING tool execution or before result commit
  ↓
Restart
  ↓
Recovery replays from durable markers
  ↓
But: Host has no way to know if tool #123 already executed
  ↓
Tool may execute twice → side effects duplicated
```

**Current Classification:**

| Item | Classification | Authority | Durability |
|------|---|---|---|
| Turn acceptance | **A** (Authority) | Ack obligations (JSON) | Full |
| Turn execution status | **C** (Ephemeral) | In-memory RunLifecycle | Lost on crash |
| Tool call identity | **D** (Unknown) | Depends on tool_call tracking | **GAP** |
| Tool execution result | **B** (Projection) | SQLite transcript, but no idempotency key | Partial |
| Idempotency tracking | **D** (Unknown) | **NOT TRACKED** | **MISSING—Critical Gap** |
| Recovery checkpoint | **C** (Ephemeral) | None for mid-execution | **MISSING—Critical Gap** |

**The FeltDB Solution:**

FeltDB provides the missing authority layer:

```
Operation {
  operationId: UUID,
  status: enum (accepted | executing | completed | failed),
  idempotencyKey: string,
  resultSnapshot: Uint8Array,
  checkpoint: Uint8Array,
}
```

With guarantees:
1. **Idempotent writes** — same `operationId` + `idempotencyKey` cannot be re-executed
2. **Durable state machine** — status transitions are durable before proceeding
3. **Exactly-once semantics** — recovery can query by ID and know whether to retry, resume, or skip

**Decision:** This is where FeltDB demonstrates its value. SQLite is not sufficient because:
- SQLite is session-local; tool execution may involve multiple processes
- No cross-process idempotency tracking
- Retry logic is implicit and unsafe
- Recovery is guesswork

### 4. Coordinator State & Recovery

**Classification:**

| Item | Classification | Authority | Durability |
|------|---|---|---|
| Routing tables | **C** (Ephemeral) | In-memory coordinator state | Lost on crash |
| Message buffers | **C** (Ephemeral) | In-memory queues | Lost on crash |
| Streaming activity | **C** (Ephemeral) | Live socket/stream handles | Lost on crash |
| OAuth pending state | **C** (Ephemeral) | In-memory Map | Lost on crash |
| **Durable coordination facts** | **D** (Unknown) | **MISSING** | **MISSING** |

**The Problem:**

Coordinator crash = all in-flight coordination lost. Clients must reconnect and resend. Works if clients expect this, but:
1. No durability of accepted-but-not-yet-executed operations
2. No message queue guarantees
3. No ordering guarantees across restarts
4. Streaming disrupted

**The FeltDB Opportunity:**

FeltDB can provide durable coordination operations:

```
CoordinatorOperation {
  operationId: UUID,
  sequence: number,
  type: enum (route | stream_open | stream_close | reaction),
  payload: JSON,
  status: enum (accepted | in_flight | completed),
  frontier: number,  // Last processed sequence
}
```

**Recovery Protocol:**

```
On coordinator restart:
  1. Query FeltDB for last frontier/checkpoint
  2. Fetch all operations since that frontier
  3. Replay operations in sequence order
  4. Re-establish routing state
  5. Notify clients of frontier so they know what already executed
  6. Clients can request results from past operations if desired
```

**Critical Design Point:**

Operations must be **durable before coordinator acknowledges** to client. NOT fire-and-forget shadow-writes. This is the actual authority test.

**Decision:** FeltDB + durable operation protocol enables true coordination across restarts.

### 5. Usage Records & Analytics

**Current Authority:** Settings JSON (`SandInferenceRouterUsage`)  
**Storage:** Periodic writes to `sand-settings.json`  
**State Owner:** Electron main / Settings store  
**Durability:** Periodic (buffered in memory, flushed to disk)  
**Multi-writer:** Single process  
**Includes:**
- Request counts per provider
- Token usage (input/output/cache)
- Last used timestamp
- Billing signals

**Candidate for FeltDB:** YES (if want real-time event stream)  
**Priority:** Low  
**Rationale:** Current approach works. FeltDB would add value only if need:
  - Append-only event log (not just summary)
  - Real-time streaming (not periodic flush)
  - Cross-session aggregation (not single-process accumulator)

### 6. Auth & Secrets

**Current Authority:** Electron secrets API + process-local tokens  
**Storage:** System keychain + memory  
**State Owner:** Electron main  
**Durability:** System-managed (not application-managed)  
**Multi-writer:** Single process  
**Includes:**
- Provider API keys
- OAuth tokens & refresh tokens
- Session credentials
- Signing keys

**Candidate for FeltDB:** NO  
**Reason:** Security boundary - should remain in system keychain, never in application database  
**Note:** FeltDB may store references/metadata (provider name, last auth time), but not secrets

### 7. MCP/Plugin State

**Current Authority:** In-memory caches + process-local state  
**Storage:** Runtime JavaScript objects  
**State Owner:** Host MCP handlers  
**Durability:** None (ephemeral)  
**Multi-writer:** Single process (within host)  
**Includes:**
- MCP server catalog
- Tool inventory
- Resource caches
- Server capabilities

**Candidate for FeltDB:** Partial  
**Priority:** Low  
**Note:** Catalog projections can be cached; definitions should be derived from servers

### 8. Provider Routing State

**Current Authority:** Settings (persistent) + runtime state (ephemeral)  
**Storage:** Settings store + JavaScript objects  
**State Owner:** Electron main + host  
**Durability:** Settings only (via SandSettingsStore)  
**Multi-writer:** Two processes (Electron main + host)  
**Includes:**
- Selected inference provider
- Provider capabilities
- Routing rules
- Connection state

**Candidate for FeltDB:** Partial  
**Priority:** Medium  
**Note:** Configuration goes to FeltDB; connection state remains ephemeral

### 9. Sandbox/Box State

**Current Authority:** Process-local in coordinator  
**Storage:** Runtime JavaScript objects  
**State Owner:** Coordinator  
**Durability:** None  
**Multi-writer:** Coordinator only  
**Includes:**
- Box connection state
- Docker container state
- Tunnel connections
- Command routing

**Candidate for FeltDB:** No  
**Reason:** Purely ephemeral; state is reconstructed on startup
**Note:** May store durable records of past box sessions for diagnostics

### 10. Recovery & Checkpoint State

**Current Authority:** Implicit in other state categories  
**Storage:** Distributed across components  
**State Owner:** Various (no single owner)  
**Durability:** Partial/implicit  
**Includes:**
- Turn recovery points
- Execution checkpoints
- Partial operation state
- Idempotency tracking

**Candidate for FeltDB:** YES  
**Priority:** Critical  
**Note:** Currently missing; FeltDB would enable proper recovery

---

## Cross-Process Authority Model

**CRITICAL ARCHITECTURAL DECISION:**

Grok Bot has three separate processes: Electron main, coordinator, host. They cannot share live objects. FeltDB integration must account for this.

### Process Boundary Model: Shared FeltDB Authority

```
Electron Main ──────┐
Host/Agent ─────────┼──> FeltDB authority (shared local access)
Coordinator ────────┘
                        │
                        ├─ operation: status, idempotency
                        ├─ execution: state machine
                        ├─ recovery: checkpoint frontier
                        └─ coordination: operation sequence
```

**Key Point:** Each process has its own FeltDB client connection to the same authority database. Not "Electron passes FeltDB object to Host." That doesn't work across process boundaries.

### Electron Main Process

**Responsibilities:**
- Application lifecycle
- Settings authority (JSON, unchanged for v1)
- Secrets (system keychain, NEVER in FeltDB)
- Coordinator process lifecycle
- Window/desktop integration

**Durable State Owned:**
- Settings (JSON via `SandSettingsStore`)
- Secrets (system keychain)

**Ephemeral State:**
- Coordinator child process handle
- Window state
- Box connector handles

**FeltDB Interaction:** Read-only (reads operations, executions for status if needed)

### Host Process

**Responsibilities:**
- Session/agent lifecycle
- Turn execution
- Tool execution
- Recovery logic
- Durable marker management

**Durable State Owned:**
- SQLite per-session DBs (`{agentId}/agent.db`)
- Recovery markers (JSON)
- **NEW: Exclusive writer to FeltDB operation/execution authority**

**Ephemeral State:**
- RunLifecycle in-memory state
- Active tool processes
- Provider connections

**FeltDB Interaction:** Read/write operations, executions, checkpoints (primary authority writer)

### Coordinator Process

**Responsibilities:**
- Message routing
- Streaming activity
- MCP bridging
- Tool invocation routing

**Durable State Owned:**
- None (all authority is ephemeral until FeltDB integration)

**Ephemeral State:**
- Routing tables
- Stream handles
- Message buffers

**FeltDB Interaction (Post-Integration):** Read/write to coordinator_operations (ordered operations, recovery frontier)

### Renderer (React)

**Responsibilities:**
- UI rendering
- User interaction

**Durable State Owned:**
- None

**Ephemeral State:**
- UI forms, scroll, modal state

**FeltDB Interaction:** None (reads via RPC)

---

## Integration Architecture: NOT Electron → Host

**DO NOT DO:** Pass FeltDB object from Electron main to Host process.

```typescript
// WRONG:
const feltdb = new FeltDB(...);
launchHost({ feltdb });  // Can't pass object across process boundary
```

**DO THIS:** Each process creates its own client to the same FeltDB authority:

```typescript
// Electron main
const feltdbConfig = { rootPath: app.getPath('userData') };
const feltdbElectron = new FeltDB(feltdbConfig);

// Separately, Host process
const feltdbHost = new FeltDB(feltdbConfig);

// Both connect to same authority database
```

This is transparent if FeltDB uses local file-based authority (likely), but explicit if it uses network/service model.

---

## Authority Boundary: What FeltDB Owns

### Durable Authority (FeltDB)

FeltDB becomes the source of truth for cross-process coordination:

| Domain | FeltDB Collection | Semantics | Guarantees |
|--------|---|---|---|
| **Operation Identity** | `operation` | Uniquely identify work accepted by the system | Immutable, durable, replayable |
| **Idempotency** | `idempotency_key` | Same key + operation cannot be duplicated | Atomic check-and-set |
| **Execution State** | `execution` | Track whether operation executed, failed, or pending | State machine transitions are durable |
| **Recovery Checkpoint** | `checkpoint` | Last known-good state before operation started | Durable frontier for restart |
| **Coordination Sequence** | `coordinator_operation` | Ordered sequence of routing/streaming operations | Sequence number, causal ordering |

### Durable Projection (SQLite)

SQLite remains authoritative for session-local data, but is now a *projection* of operation results:

| Domain | SQLite DB | Derived From | Read Authority |
|--------|---|---|---|
| **Transcript Entries** | Session DB | Operation results (from FeltDB) | SQLite for read performance |
| **Turn Content** | Session DB | Operation results + user messages | SQLite for local access |
| **Message Blobs** | Session DB | Tool execution results | SQLite for locality |
| **Session Metadata** | Session DB | Session creation + maintenance ops | SQLite (local) |

**Key Property:** Transcript data survives crashes (WAL), but derives from FeltDB operations. If you lose SQLite session DB, you can reconstruct from FeltDB operations + replayable tool execution.

### Ephemeral State (Process Memory)

Must NEVER be durable:

| Domain | Reason |
|--------|--------|
| Sockets, streams | Cannot serialize/deserialize |
| Process handles, PTYs | OS resources, not data |
| AbortControllers, promises | Tied to process lifecycle |
| UI state | Renderer-local only |
| MCP server connections | Renegotiate on startup |
| Tool execution processes | Re-launch on restart |

---

## The Proof-of-Concept: Execution Recovery

**The killer use case that proves FeltDB's value:**

**Scenario:** Tool call execution across process restart

```
1. Turn accepted, durable operation record created in FeltDB
2. Host process starts tool execution
3. Tool #123 begins (e.g., shell command, API call)
4. Process crashes BEFORE tool result is committed
5. System restarts
6. Recovery: Query FeltDB for operation status
7. FeltDB says: "Tool #123 is in EXECUTING state"
8. Recovery: Check idempotency key → matches previous attempt
9. Recovery: Tool #123 should NOT be re-executed (prevent duplicate)
10. Recovery: Check for cached result or mark as FAILED
11. Turn continues or is marked FAILED appropriately
```

**Why SQLite alone cannot do this:**
- Tool execution is cross-process (host + sandbox)
- SQLite is session-local; sandbox doesn't have access
- No durably-recorded idempotency key
- No recovery frontier across restarts

**Why FeltDB is essential:**
- Operation ID is durable and cross-process
- Idempotency key prevents duplicate execution
- Coordinator + host + recovery can all query the same authority
- Restart can discover incomplete operations
- **Exactly-once semantics are guaranteed**

This single scenario justifies FeltDB adoption.

---

## Identified Authority Bugs & Gaps

### Authority Smell: Restart-Sensitive IDs

**Issue:** Session and turn IDs may not survive process restart if generated from runtime state.

**Impact:** Conversation history may not be linked correctly after restart.

**Current Status:** Unknown (requires code audit)

**FeltDB Solution:** Centralized ID generation guarantees

### Correctness Bug: Partial Turn Execution

**Issue:** If a turn begins execution and the process crashes during tool execution, there is no durable record of the partial state.

**Scenario:**
1. Turn accepted and started
2. Tool calls generated
3. First tool executes partially
4. Process crashes before results persisted
5. Restart loses state of partial execution

**Impact:** User sees incomplete turn; tool may be re-executed; idempotency unclear

**Current Status:** No recovery mechanism exists

**FeltDB Solution:** Durable operation/job persistence with recovery

### Concurrency Bug: Coordinator State

**Issue:** Coordinator state is process-local with no synchronization with other processes.

**Scenario:**
1. Electron main reads coordinator state
2. Coordinator crashes and restarts
3. State is lost; Electron main has stale view
4. Message routing may fail silently

**Impact:** Message routing failures, lost reactions, streaming issues

**Current Status:** Implicit state loss on coordinator restart

**FeltDB Solution:** Durable coordinator event log

### Crash Recovery Bug: Idempotency

**Issue:** Tool calls lack idempotency tracking. If a process crashes after a tool executes but before results are committed, re-execution is indistinguishable.

**Impact:** Tool side effects may be applied twice

**Current Status:** No idempotency keys in current code

**FeltDB Solution:** Durable idempotency record per tool call

---

## Authority Writing Rule: Blocking vs. Fire-and-Forget

**CRITICAL RULE FOR FELTDB AUTHORITY:**

No FeltDB operation may be described as authoritative if failure of that operation can be ignored after the application has externally acknowledged the state transition.

### Authoritative Writes (BLOCKING)

These must complete durably before the application acknowledges success:

```typescript
// Accept an operation
operation = {
  operationId: UUID,
  status: ACCEPTED,
  idempotencyKey: ...,
};

// MUST wait for FeltDB write to complete
await feltdb.operation.put(operation);

// ONLY THEN acknowledge to caller
return { accepted: true, operationId };
```

If FeltDB write fails, the mutation does not complete. Caller does not proceed.

### Non-Authoritative Writes (Fire-and-Forget)

These can fail without affecting application state:

```typescript
// Log usage telemetry
await feltdb.usage_event.put(event).catch(err => {
  log.warn('Telemetry write failed', err);
  // Application continues; loss is acceptable
});
```

**Current Violation:** The previous proposal made coordinator events "fire-and-forget shadow writes." That contradicts the definition of authority.

**Fix:** Coordinator events MUST be blocking if FeltDB is the authority. Fire-and-forget is only acceptable for telemetry/audit logs.

---

## Concurrency & Multi-Writer Analysis

### Scenarios with Multiple Writers

1. **Settings:**
   - **Writers:** Electron main (user-initiated), Host (computed values)
   - **FeltDB Requirement:** Optimistic concurrency or application-level coordination
   - **Mitigation:** Single owner pattern; host reads but does not write

2. **Turn State:**
   - **Writers:** Coordinator (creates), Host (updates), Sandbox (tool results)
   - **FeltDB Requirement:** Atomic compare-and-swap for state transitions
   - **Mitigation:** Durable lock or version-based updates

3. **Execution Records:**
   - **Writers:** Host (status), Tool Sandbox (results), Coordinator (routing)
   - **FeltDB Requirement:** Idempotent upserts, version tracking
   - **Mitigation:** All writes append to immutable event log

4. **Coordinator State:**
   - **Writers:** Coordinator main (primary), External clients (side-channel)
   - **FeltDB Requirement:** Durable event sourcing or message queue
   - **Mitigation:** Coordinator is single writer; external access via queries

### Multi-Process Crash Scenarios

1. **Electron Main Crashes:**
   - FeltDB: Accessible by host/coordinator without main
   - Settings: Can be recovered from FeltDB
   - Coordinator: Can continue running
   - **Recovery:** Restart main, re-establish connections to coordinator

2. **Coordinator Crashes:**
   - FeltDB: Accessible by other processes
   - Message queue: Must be durable for restart
   - In-flight turns: Must track in FeltDB
   - **Recovery:** Restart coordinator, replay message queue from FeltDB

3. **Host Crashes:**
   - FeltDB: Accessible by coordinator
   - In-flight execution: Must track in FeltDB
   - Tool state: Can be recovered from execution records
   - **Recovery:** Restart host, check for interrupted executions, resume

4. **Turn Interruption:**
   - Process crashes mid-turn
   - FeltDB: Contains partial state record
   - **Recovery:** Validate previous steps, resume from checkpoint or restart

---

## FeltDB Capability Requirements

### Essential Capabilities

1. **Durable Blob Storage**
   - Store arbitrary serialized state (proto messages)
   - Content-addressable by SHA-256
   - Retrieve by blob ID
   - **Status in FeltDB:** Available ✓

2. **Key-Value State**
   - Store metadata, settings, simple structs
   - Atomic single-key writes
   - **Status in FeltDB:** Available ✓

3. **Idempotent Upserts**
   - Write with idempotency key
   - Same key + data = idempotent
   - Same key + different data = error or conditional
   - **Status in FeltDB:** Partial (need to evaluate conditional semantics)

4. **Ordered Events/Log**
   - Append-only event records
   - Causally ordered
   - Replay from checkpoint
   - **Status in FeltDB:** Need to evaluate

5. **Indexed Queries**
   - Query by state machine state
   - Find pending executions
   - Find incomplete turns
   - **Status in FeltDB:** Need to evaluate

### Nice-to-Have Capabilities

1. **Change Subscriptions**
   - Watch collection for writes
   - Push changes to subscribers
   - **Status in FeltDB:** Need to evaluate

2. **Multi-Key Transactions**
   - Atomic updates across multiple keys
   - Conditional on read values
   - **Status in FeltDB:** Probably not available; application-level workaround needed

3. **Sequence Allocation**
   - Centralized counter/sequence
   - Atomically increment and return
   - **Status in FeltDB:** Probably available via blob versioning

---

## Proposed FeltDB Collections

### 1. Settings

```
Collection: settings
Key: setting_name (string)
Value: {
  value: JSON,
  version: number,
  lastModified: timestamp,
  modifiedBy: process_id,
}
```

Maps to: Current `SandStoredSettings`

### 2. Sessions

```
Collection: sessions
Key: session_id (string)
Value: {
  sessionId: string,
  createdAt: timestamp,
  lastActivity: timestamp,
  applicationScope: string,
  metadata: JSON,
  blobId: Uint8Array (proto serialized),
}
```

Maps to: `AgentMetadata`, conversation sessions

### 3. Turns

```
Collection: turns
Key: turn_id (string)
Value: {
  turnId: string,
  sessionId: string,
  index: number,
  status: enum (pending | executing | complete | error),
  createdAt: timestamp,
  completedAt: timestamp | null,
  contentBlobId: Uint8Array (proto serialized),
  parentTurnId: string | null,
}
```

Maps to: `ConversationTurn`, turn state

### 4. ToolCalls

```
Collection: tool_calls
Key: tool_call_id (string)
Value: {
  toolCallId: string,
  turnId: string,
  toolName: string,
  status: enum (pending | executing | complete | error),
  argumentsBlob: Uint8Array,
  resultBlob: Uint8Array | null,
  error: string | null,
  createdAt: timestamp,
  resultAt: timestamp | null,
  idempotencyKey: string,
}
```

Maps to: Tool execution tracking

### 5. Executions

```
Collection: executions
Key: execution_id (string)
Value: {
  executionId: string,
  turnId: string,
  status: enum (pending | executing | complete | failed),
  checkpointBlobId: Uint8Array,
  logs: string[],
  startedAt: timestamp,
  completedAt: timestamp | null,
  processId: string,
}
```

Maps to: Execution state, recovery checkpoints

### 6. CoordinatorMessages

```
Collection: coordinator_messages
Key: message_id (string)
Value: {
  messageId: string,
  turnId: string | null,
  sequenceNumber: number,
  payload: JSON,
  createdAt: timestamp,
  deliveredAt: timestamp | null,
  acknowledgments: string[],
}
```

Maps to: Message routing, reliability

### 7. UsageEvents

```
Collection: usage_events
Key: event_id (string)
Value: {
  eventId: string,
  timestamp: timestamp,
  provider: string,
  eventType: enum (request | tool_call | completion),
  tokens: {
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
  },
  requestId: string,
}
```

Maps to: Analytics, billing signals

### 8. RecoveryCheckpoints

```
Collection: recovery_checkpoints
Key: checkpoint_id (string)
Value: {
  checkpointId: string,
  processId: string,
  scope: enum (turn | execution | session),
  scopeId: string,
  checkpointData: Uint8Array,
  createdAt: timestamp,
  expiresAt: timestamp,
}
```

Maps to: Crash recovery, state reconstruction

---

## Implementation Roadmap

### Phase 0: Discovery ✓ (Complete)

Completed:
- [x] Audit current authority model
- [x] Identify cross-process gaps
- [x] Document execution recovery use case
- [x] Clarify FeltDB role as substrate

### Phase 1: Vertical Slice (Execution Recovery)

**Goal:** Prove FeltDB as authority for exactly-once execution

**Scope:**
1. Implement FeltDB `operation` + `execution` collections
2. Tool execution writes durable operation record BEFORE executing
3. Idempotency key prevents duplicate execution
4. Restart: query FeltDB, discover incomplete operation, skip re-execution
5. Test: kill process mid-tool-execution, restart, verify no duplicate

**Success Criteria:**
- Tool execution is guaranteed exactly-once
- Recovery finds incomplete operations
- Restart respects idempotency keys

**Do NOT do in this phase:**
- Coordinator recovery
- Settings migration
- Cross-session queries
- Broad adapter

**Why this first:** Smallest vertical slice that proves the authority substrate works.

### Phase 2: Coordinator Durability

**Goal:** Enable coordinator to recover operations without client re-sends

**Scope:**
1. Implement FeltDB `coordinator_operation` collection
2. Coordinator writes operation durably BEFORE executing
3. Restart: replay operations since last frontier
4. Clients: can query past operation results if desired

**Success Criteria:**
- Coordinator restart does not lose in-flight operations
- Message ordering is preserved
- Duplicate operations are prevented

### Phase 3: Recovery Orchestration

**Goal:** Comprehensive crash recovery across process boundaries

**Scope:**
1. Implement FeltDB `recovery_checkpoint` collection
2. Mark frontier after successful operation completion
3. Restart: resume from last checkpoint
4. Test kill/restart scenarios

### Phase 4: Defer

Settings, usage analytics, cross-session queries: defer until later if needed.

No adoption of these without clear product requirement.

---

## Risk Assessment

### Low Risk
- **Vertical slice execution recovery** (small scope, can roll back, high value proof)

### Medium Risk
- **Coordinator durability** (touches multiple processes, needs careful protocol)
- **Recovery orchestration** (testing-intensive, crash scenarios complex)

### High Risk
- **Replacing SQLite** (NOT planned; would lose session-local benefits)
- **Fire-and-forget authority writes** (contradiction; don't do this)

---

## FeltDB Capability Validation

Before proceeding, validate against FeltDB v0.4.17+ capabilities discovered in Paseo:

- [x] **Atomic admission** — needed for operation acceptance
- [x] **Durable operation persistence** — needed for operation tracking
- [x] **Durable deduplication** — needed for idempotency
- [x] **Immutable records** — needed for event log
- [x] **Sequence numbering** — needed for coordinator ordering
- [ ] **Conditional writes / putIfAbsent** — TBD (not blocking for v1)
- [ ] **Subscriptions** — TBD (not blocking for v1)

If any critical capability is missing, identify as blocker before Phase 1.

---

## Final Recommendation

**ADOPT FeltDB AS AUTHORITY SUBSTRATE**

Proceed with:
1. Phase 1 vertical slice (execution recovery)
2. Validate on that slice
3. Proceed to phases 2+ based on success

Do NOT proceed with:
- Settings migration (not needed yet)
- Usage analytics (telemetry, not authority)
- Broad adapter pattern
- Fire-and-forget authority writes
- Replacing SQLite for transcript data

---

## Next Steps

1. **Revise FELTDB-AUTHORITY-MODEL.md** (aggregate-based schema, not relational)
2. **Revise FELTDB-MIGRATION-PLAN.md** (vertical slice approach)
3. **Revise FELTDB-GAPS.md** (use Paseo findings, not unknowns)
4. **Get stakeholder alignment** (architecture + Paseo team)
5. **Begin Phase 1.1** (FeltDB client + operation collection)

---

## Appendices

### A. Glossary

- **Authority:** The source of truth for durable application state
- **Projection:** Derived state that can be rebuilt from authority
- **Ephemeral:** Process-local state that should never be durable
- **Idempotency:** Property that repeating an operation has the same effect as doing it once
- **Recovery:** Process of rebuilding state after a crash or failure
- **Crash Safety:** Guarantee that the system can recover to a consistent state after any crash

### B. Related Documents

- `docs/FELTDB-AUTHORITY-MAP.md` — Complete state inventory
- `docs/FELTDB-AUTHORITY-MODEL.md` — Proposed FeltDB schema and mutation rules
- `docs/FELTDB-MIGRATION-PLAN.md` — Phased implementation plan
- `docs/FELTDB-GAPS.md` — Required FeltDB capabilities

---

**Document Status:** Initial Draft  
**Last Updated:** 2026-08-24  
**Requires Review:** Architecture, coordinator maintainers, storage team
