# FeltDB as Authority Substrate: Evaluation

**Status:** Discovery/Architecture Planning  
**Scope:** Grok Bot 0.18 Reconstructed  
**Objective:** Evaluate and plan FeltDB as the authoritative durable state substrate for the application

## Executive Summary

Grok Bot 0.18 Reconstructed is a well-architected desktop application with clear process boundaries and **already has SQLite-based persistence as the authority substrate**. The application manages several categories of persistent state through multiple mechanisms:

- **Session/Turn/Transcript State:** SQLite with WAL (authority) per agent session
- **Session Metadata & KV Store:** SQLite (authority) per agent session  
- **Conversation Blobs:** SQLite separate database per agent
- **Durable Recovery Markers:** JSON files (ack obligations, pending wakes, upgrade state)
- **Settings & Configuration:** JSON files with atomic writes (temp-file + rename pattern)
- **Coordinator State:** Process-local with no explicit durability
- **Usage Records:** Settings JSON (periodic persistence)
- **Auth/Secrets:** Electron secrets API, NOT durable application state
- **MCP/Plugin State:** In-memory caches and process-local stores

### Key Discovery

The application **already uses SQLite as the primary durable state authority**, but:
- Each session/agent has its own isolated SQLite database
- No cross-session or cross-process coordination via central authority
- No global transaction log or unified schema
- Module-level Maps track DB handles (process-local, not durable)
- Recovery is session-scoped, not application-scoped

### Recommendation

**EVALUATE - CONSIDER ADOPTION FOR CROSS-SESSION COORDINATION**

The existing SQLite approach is solid for per-session durability. FeltDB could add value as a **secondary coordination layer** for:

1. **Cross-session state** (not present in current architecture)
2. **Global coordination** (coordinator, routing, usage aggregation)
3. **Multi-process coordination** (beyond per-session isolation)
4. **Centralized authority** for application-level state

However, the recommendation is **NOT to replace SQLite**, but rather to evaluate whether FeltDB should supplement it for cross-session concerns.

**If adopting FeltDB:**
- Keep SQLite for per-session conversation/turn authority
- Use FeltDB for global/cross-session state (usage, routing, coordinator sync)
- Define clear boundaries to avoid duplication
- FeltDB would require: conditional writes, multi-collection transactions, indexed subscriptions

**Do not adopt if:**
- Current per-session SQLite approach is sufficient for product goals
- No cross-session coordination is needed
- Complexity of dual-substrate architecture outweighs benefits

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

## Current State Inventory

### 1. Settings & Configuration

**Current Authority:** JSON files on disk  
**Storage:** `SandSettingsStore` (atomic file writes)  
**State Owner:** Electron main  
**Durability:** Full (filesystem persistence)  
**Multi-writer:** No (single-process)  
**Includes:**
- Theme preferences
- Update track selection
- MCP server configuration
- Auto-review instructions
- Local tool permissions
- Inference provider selection
- Box runtime (remote vs local)
- Sidebar sections
- Timezone overrides
- Agent model selection

**Candidate for FeltDB:** Optional  
**Priority:** Low  
**Note:** Works well with JSON; migration would be low-risk but low-value. Could consolidate if centralizing all state.

### 2. Session & Conversation Lifecycle

**Current Authority:** SQLite per-session database (`agent.db` in `{agentId}/` directory)  
**Storage:** `SandAgentDb` (SQLite with WAL mode)  
**State Owner:** Host process (exclusive access per session)  
**Durability:** Full (SQLite WAL ensures durability and recovery)  
**Multi-writer:** Single writer per session (enforced by `liveDbHandleCount()` check)  
**Includes:**
- Session identity & metadata (UUID agentId)
- Conversation transcript entries
- KV store (metadata, profile, memory, etc.)
- Turn state (seq numbers, markers)
- Execution checkpoints

**Candidate for FeltDB:** NO (replace SQLite)  
**Candidate for FeltDB:** YES (supplement for cross-session queries)  
**Priority:** Medium (if need cross-session access patterns)  
**Note:** SQLite per-session is already durable and crash-safe. FeltDB would only add value for cross-session coordination (querying state across multiple agents, global ledger).

### 3. Turn Execution State

**Current Authority:** SQLite (durable markers) + process-local state  
**Storage:** 
  - Durable: SQLite transcript entries, checkpoint markers, ack obligations
  - Ephemeral: RunLifecycle Maps (`inFlightRunCounts`, `sessionActivities`)
**State Owner:** Host process (turn-runtime.ts, transcript-manager.ts)  
**Durability:** Partial (durable framework, ephemeral details)  
**Multi-writer:** No (single host process, exclusive session access)  
**Includes:**
- Turn progress & status (entries in SQLite)
- Tool execution results (in transcript entries)
- Ack obligations (durable state store)
- Pending background work (durable JSON marker file)
- Error/retry state (in-memory, re-driven from durable markers)

**Candidate for FeltDB:** NO (SQLite sufficient)  
**Priority:** N/A  
**Note:** Current approach is solid. Ack obligations and pending wakes already provide durability for recovery. No FeltDB gap identified.

### 4. Coordinator State

**Current Authority:** Process-local in coordinator child process  
**Storage:** Runtime memory (JavaScript object graph)  
**State Owner:** Coordinator process  
**Durability:** None (crash-lost, but can be re-initiated)  
**Multi-writer:** Single process (external clients via IPC)  
**Includes:**
- Transcript routing tables
- Streaming activity (active streams)
- Reaction event handlers
- MCP bridge state
- Message queues (transient)
- OAuth pending registry

**Candidate for FeltDB:** YES - for centralized routing  
**Priority:** Medium  
**Rationale:** Coordinator crash loses routing state. FeltDB could provide durable message queue + routing table, allowing coordination to survive restarts. But current fire-and-forget approach works if clients re-connect on coordinator restart.

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

## Process Boundary Analysis

### Electron Main Process

**Responsibilities:**
- Application lifecycle
- Settings management
- Auth/secrets handling
- Coordinator ownership
- Box connector management
- Renderer bridge (preload)
- Window state persistence

**Durable State Owned:**
- Settings (JSON file via `SandSettingsStore`)
- Secrets (system keychain, NOT application state)
- Usage summary (periodic persistence to settings)

**Ephemeral State:**
- Coordinator child process handle
- Box connection handles
- Renderer communication ports
- Module-level tracking Maps

**SQLite Interaction:** No (host process owns session databases)

**FeltDB Opportunity:** Could own global settings/config if centralizing

### Coordinator Process (Child)

**Responsibilities:**
- Gateway communication / transport
- OAuth loopback registry
- MCP tool relaying
- Message routing (transient)
- Streaming state (transient)

**Durable State Owned:**
- None (all state is ephemeral and process-local)

**Ephemeral State:**
- Transport generation tracking
- Message routing tables
- Stream handles
- OAuth pending registry (in-memory Map)

**SQLite Interaction:** No direct access (queries via host)

**FeltDB Opportunity:** Could own durable message queue + routing log (enables restart without re-connection)

### Host Process

**Responsibilities:**
- **Owner of all session/agent databases**
- Session creation/deletion
- Turn execution
- Transcript management
- Background work tracking
- Ack obligation enforcement
- Upgrade & recovery coordination

**Durable State Owned:**
- Session SQLite databases (`{agentId}/agent.db`)
- Conversation blob databases (`{agentId}/conversation-blobs.db`)
- Durable recovery markers (JSON files)
  - Ack obligations
  - Pending wakes (`sand-pending-wake.json`)
  - Upgrade markers
- Profile & settings per session (JSON)
- Active agent pointer (atomic rename)

**Ephemeral State:**
- RunLifecycle Maps (in-flight counters)
- Active tool processes
- Provider connections
- Streaming buffers

**SQLite Interaction:** Exclusive handle per session (enforced by `liveDbHandleCount()`)

**FeltDB Opportunity:** Could share turn metadata across sessions (if needed)

### Renderer (React)

**Responsibilities:**
- UI rendering
- User input handling
- Display state
- Streaming display buffer

**Durable State Owned:**
- None

**Ephemeral State:**
- UI forms
- Scroll position
- Modal state
- Streaming UI buffers

**SQLite/FeltDB Interaction:** None (all reads via RPC to host)

---

## Authority vs. Projection Analysis

### Authority State (Durable Truth)

State that must be authoritative and persist across crashes:

| Domain | Current Owner | Proposed FeltDB Owner |
|--------|---------------|----------------------|
| Settings | JSON file | FeltDB `settings` |
| Sessions | Blob store | FeltDB `sessions` |
| Turns | Blob store | FeltDB `turns` |
| Tool calls | Blob store | FeltDB `tool_calls` |
| Execution state | Process-local | FeltDB `executions` |
| Message queue | Process-local | FeltDB `coordinator_messages` |
| Usage records | Settings | FeltDB `usage_events` |
| Recovery checkpoints | None | FeltDB `recovery_checkpoints` |

### Projection State (Derived, Reconstructible)

State that can be rebuilt from authority:

| Domain | Current | Proposed |
|--------|---------|----------|
| UI state | Renderer memory | Renderer memory (per-session) |
| Streaming buffers | Runtime memory | Can be cleared on restart |
| MCP catalog | Runtime cache | Can be fetched from servers |
| Provider capabilities | Runtime state | Can be derived from settings + provider APIs |
| Dashboard summaries | Settings | Can be computed from FeltDB usage events |

### Ephemeral State (Process-Local Only)

State that should never be durable:

| Domain | Reason |
|--------|--------|
| Active sockets | Cannot serialize/restore |
| AbortControllers | Lifecycle is process-tied |
| Child process handles | OS resource, not data |
| PTY handles | Terminal I/O state |
| In-flight promises | Can be re-executed |
| Renderer subscriptions | Communication artifact |
| Transient buffers | Intermediate data |

---

## Current Authority Bugs & Issues

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

## Migration Strategy (Phased)

### Phase 0: Discovery (This PR)
- [ ] Document current authority boundaries
- [ ] Identify FeltDB gaps
- [ ] Design FeltDB collections
- [ ] Create migration plan
- [ ] Get architectural approval

### Phase 1: FeltDB Adapter
- [ ] Create `AuthorityStore` application interface
- [ ] Implement FeltDB-backed store
- [ ] Keep existing persistence alongside
- [ ] No behavior changes

### Phase 2: Settings Migration
- [ ] Dual-read/shadow-write settings
- [ ] Validate FeltDB and file are in sync
- [ ] Cutover reads to FeltDB
- [ ] Remove file persistence

### Phase 3: Session/Turn Authority
- [ ] Durable session creation
- [ ] Durable turn tracking
- [ ] Recovery on restart
- [ ] Coordinator integration

### Phase 4: Execution State
- [ ] Tool call durability
- [ ] Execution recovery
- [ ] Idempotency tracking
- [ ] Crash recovery testing

### Phase 5: Coordinator Durability
- [ ] Message queue persistence
- [ ] Event log
- [ ] Recovery protocols

### Phase 6: Cleanup
- [ ] Remove obsolete blob stores
- [ ] Remove unused file persistence
- [ ] Verify no regressions

---

## Risk Assessment

### Low Risk
- Settings migration (currently working, well-understood)
- Usage records (non-critical, can fall back)

### Medium Risk
- Session/turn authority (high value but requires careful recovery logic)
- Provider routing state (touches multiple processes)

### High Risk
- Coordinator durability (complex state machine, many processes interact)
- Execution recovery (must handle partial failures correctly)
- Process crash scenarios (testing-intensive)

---

## Next Steps

1. **Complete the codebase audit** (Exploration agent findings)
2. **Build authority map** (detailed state inventory)
3. **Design authority model** (exact FeltDB collections + mutation rules)
4. **Create migration plan** (PR breakdown + dependencies)
5. **Document FeltDB gaps** (specific substrate needs)
6. **Get stakeholder review** (architecture alignment)
7. **Begin Phase 1** (FeltDB adapter implementation)

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
