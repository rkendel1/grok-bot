# FeltDB Authority Model

Proposed FeltDB integration as a **supplementary coordination layer** (not replacement for existing SQLite).

## Architecture Decision

### Current State (SQLite Per-Session)

```
Electron Main         Host Process              Renderer
  │                      │                         │
  ├─ Settings JSON       ├─ Session DB A          └─ UI State
  ├─ Secrets            ├─ Session DB B             (ephemeral)
  └─ Usage Summary      ├─ Session DB C
                        ├─ Durable Markers
                        └─ Recovery State
```

**Pros:**
- Per-session isolation (simple, fast)
- Built-in durability (SQLite + WAL)
- Clear crash recovery (per-session)
- No central coordination needed

**Cons:**
- No cross-session queries
- No global transaction log
- Usage data split between processes
- Coordinator state lost on crash (not durable)

### Proposed Architecture (FeltDB Overlay)

```
Electron Main         Host Process              FeltDB Authority Layer
  │                      │                           │
  ├─ Settings JSON       ├─ Session DB A            ├─ Global settings
  │                      ├─ Session DB B            ├─ Provider routing
  │  ┌──────────────────┤ Session DB C             ├─ Usage events
  │  │                  ├─ Durable Markers         ├─ Coordinator events
  │  │                  └─ Recovery State          └─ Cross-session metadata
  │  │
  ▼  ▼
 Settings Sync      Turn State Sync
 (optional)         (if needed)
```

**New Capabilities:**
- Central authority for coordination state
- Global usage ledger (append-only event log)
- Cross-session state (if needed for future features)
- Durable coordinator message queue (optionally)

**Unchanged:**
- Per-session SQLite for turn/transcript data (already durable)
- Settings in JSON (can sync to FeltDB optionally)
- Secrets in system keychain (NEVER in FeltDB)

---

## Proposed FeltDB Collections

### Collection: `global_settings`

**Purpose:** Centralized settings (supplements per-session JSON)

**Optional:** Yes (can keep JSON-only if simpler)

```
Key: setting_name (string)
Value: {
  name: string,
  value: JSON,
  version: number,
  lastModified: timestamp,
  modifiedBy: process_id,
}
```

**Examples:**
- `inference_provider` → current provider selection
- `box_runtime` → remote vs. local Docker
- `update_track` → stable/beta/canary

**Write Path:**
1. User changes setting in UI
2. Electron main writes to settings JSON (atomic)
3. Optionally syncs to FeltDB (shadow write)
4. Other processes read from JSON (or cache sync if FeltDB)

**Read Path:**
- Electron main: JSON file (authoritative)
- Host process: Settings API (reads from JSON)

**FeltDB Value Add:** Allows coordinator or host to read settings without going through Electron main

**Migration Strategy:**
- Phase 1: Shadow writes (JSON → FeltDB, but read JSON)
- Phase 2: Dual-read (read both, verify consistency)
- Phase 3: Cutover to FeltDB (if beneficial)

---

### Collection: `coordinator_events` (Optional)

**Purpose:** Durable coordinator message log (for recovery if coordinator crashes)

**Optional:** Yes (current fire-and-forget works if clients reconnect)

```
Key: event_id (string, UUID)
Value: {
  eventId: string,
  sequenceNumber: number,
  timestamp: timestamp,
  eventType: enum (message_routed | stream_open | stream_close | reaction),
  payload: JSON,
  acknowledgments: string[], // which clients acked
}
```

**Examples:**
- Message routed to tool
- Stream opened/closed
- Reaction event received

**Write Path:**
1. Coordinator processes event
2. Appends to in-memory buffer
3. Optionally persists to FeltDB (shadow write)

**Read Path (After Restart):**
1. Coordinator reads last sequence number from FeltDB
2. Replays pending events to re-establish routing state
3. Clients re-connect and continue

**FeltDB Value Add:** Eliminates message loss on coordinator restart

**Migration Strategy:**
- Phase 1: Optional shadow writes (benchmark impact)
- Phase 2: Use for recovery if coordinator crashes
- Phase 3: Measure if it actually solves user-visible issues

---

### Collection: `usage_events` (Optional)

**Purpose:** Durable usage ledger (supplements periodic settings flush)

**Optional:** Yes (current approach works)

```
Key: event_id (string, UUID)
Value: {
  eventId: string,
  timestamp: timestamp,
  provider: string (Cursor | Claude | Codex | OpenRouter),
  eventType: enum (request | completion | tool_call),
  tokens: {
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
  },
  requestId: string,
  modelId: string,
}
```

**Examples:**
- Request to Claude (5 API calls, 1000 input tokens)
- Completion from Codex (500 output tokens)
- Tool call execution (OpenRouter)

**Write Path:**
1. Inference router completes request
2. Accumulates in-memory counter
3. Periodically flushes to settings JSON
4. Optionally appends individual events to FeltDB

**Read Path:**
- UI queries settings store (current total)
- Analytics query FeltDB (event log for detailed audit)

**FeltDB Value Add:** Append-only audit log (can reconstruct totals, no data loss)

**Migration Strategy:**
- Phase 1: Start appending events (shadow write)
- Phase 2: Validate event log accuracy
- Phase 3: Deprecate periodic JSON flush if confidence high

---

### Collection: `session_metadata` (Optional)

**Purpose:** Cross-session queries (if future features need them)

**Optional:** Yes (not needed currently)

```
Key: session_id (string, agent_id)
Value: {
  sessionId: string,
  createdAt: timestamp,
  lastActivity: timestamp,
  agentName: string,
  totalTurns: number,
  totalTokens: {
    input: number,
    output: number,
  },
  preferredProvider: string,
  isArchived: boolean,
}
```

**Examples:**
- "Show me all sessions from last week"
- "Total token usage across all agents"
- "Sessions with error rate > 5%"

**Write Path:**
1. Host process creates/updates session
2. Writes session metadata to SQLite (authoritative)
3. Syncs metadata to FeltDB (projection)

**Read Path:**
- Cross-session queries: FeltDB
- Single-session queries: SQLite (faster)

**FeltDB Value Add:** Enables dashboard queries, analytics

**Migration Strategy:**
- Phase 1: Defer until needed
- Phase 2: If dashboard feature requested, implement then

---

## Alternative: Minimal FeltDB (Low Complexity)

If only goal is to **supplement without major changes**:

### Minimal Collection: `global_coordinator_state`

Single key-value for coordinator recovery:

```
Key: "coordinator_state"
Value: {
  lastSequenceNumber: number,
  activeRoutes: Record<string, string>,
  pendingMessages: Array,
  lastCheckpoint: timestamp,
}
```

**Benefits:**
- Minimal schema
- Optional (coordinator works without it)
- Easy to add later

**Drawbacks:**
- No append-only guarantees
- Single large write on each update
- Not an event log

---

## Authority vs. Projection: Detailed Rules

### Settings Authority

**Authority:** JSON file (Electron main writes)  
**Projection:** FeltDB (shadow copy)  
**Conflict Resolution:** JSON is truth; FeltDB is stale replica  
**Sync Direction:** JSON → FeltDB (one-way)  

**Read Semantics:**
```
if read_setting_from_any_process:
  return settings_json  // Always authoritative
  
if_read_from_coordinator_after_migration:
  // Option 1: FeltDB has cached copy (good enough)
  // Option 2: Query settings RPC to Electron main (slower)
```

### Usage Events Authority

**Authority:** Settings JSON (current total)  
**Projection:** FeltDB events (append-only log)  
**Conflict Resolution:** Recompute total from FeltDB events  
**Sync Direction:** Bidirectional  

**Read Semantics:**
```
if read_usage_for_display:
  return settings_json  // Fast, authoritative total
  
if_audit_usage_detailed:
  query_usage_events_from_feltdb  // Event log
  validate_total_matches_json     // Sanity check
```

### Coordinator State Authority

**Authority:** None currently (ephemeral)  
**Projection:** FeltDB optional backup  
**Conflict Resolution:** N/A (ephemeral)  
**Sync Direction:** One-way (coordinator → FeltDB optional)  

**Restart Semantics:**
```
on_coordinator_restart:
  if feltdb_has_coordinator_events:
    replay_from_last_sequence_number
  else:
    start_fresh  // Clients reconnect anyway
```

### Session Metadata Authority

**Authority:** SQLite (host process exclusive)  
**Projection:** FeltDB optional (for cross-session queries)  
**Conflict Resolution:** SQLite is truth; FeltDB is stale replica  
**Sync Direction:** SQLite → FeltDB (eventual consistency)  

**Read Semantics:**
```
if single_session_query:
  read_from_sqlite  // Faster, authoritative
  
if_cross_session_query:
  read_from_feltdb  // Can query multiple sessions
  // Note: May be slightly stale (ok for analytics)
```

---

## Mutation Rules

### Settings Mutation

```typescript
// WRITE: Only Electron main
function setSetting(key: string, value: JSON) {
  // 1. Validate
  if (!isValidSetting(key, value)) throw Error("Invalid setting");
  
  // 2. Write to JSON (atomic)
  settingsStore.persist({ ...current, [key]: value });
  
  // 3. Shadow-write to FeltDB (fire-and-forget)
  feltdb.global_settings.put({
    key: key,
    value: value,
    version: current.version + 1,
    lastModified: now(),
  }).catch(err => log.warn("FeltDB sync failed", err));
  
  // 4. Broadcast change
  emitSettingChanged(key, value);
}

// READ: Any process
function getSetting(key: string): JSON {
  // Read from JSON (authoritative)
  return settingsStore.get()[key];
  // OR if Electron main not accessible:
  // return feltdb.global_settings.get(key).value;
}
```

### Usage Event Mutation

```typescript
// APPEND: Any process that generates a usage event
async function recordUsageEvent(event: UsageEvent) {
  // 1. Append to in-memory accumulator
  usageAccumulator.add(event);
  
  // 2. Append to FeltDB (durable event log)
  await feltdb.usage_events.put({
    eventId: generateUUID(),
    timestamp: now(),
    ...event,
  });
  
  // 3. Periodically flush accumulator to settings JSON
  if (should_flush_accumulator()) {
    settingsStore.setInferenceRouterUsage(usageAccumulator.flush());
  }
}

// READ: Total usage (from settings)
function getUsageTotal(): UsageTotal {
  return settingsStore.load().inferenceRouterUsage;
}

// READ: Detailed event log (from FeltDB)
async function getUsageEventLog(since: timestamp): UsageEvent[] {
  return feltdb.usage_events.query({ timestamp: { $gte: since } });
}
```

### Coordinator Event Mutation (Optional)

```typescript
// APPEND: Coordinator process only
async function recordCoordinatorEvent(event: CoordinatorEvent) {
  // 1. Process immediately (authoritative in runtime)
  coordinatorState.apply(event);
  
  // 2. Shadow-persist to FeltDB (optional durability)
  await feltdb.coordinator_events.put({
    eventId: generateUUID(),
    sequenceNumber: event.seq,
    ...event,
  }).catch(err => {
    // Non-blocking: if FeltDB fails, coordinator still works
    log.warn("Failed to persist coordinator event", err);
  });
}

// RECOVERY: After coordinator restart
async function recoverCoordinatorState() {
  // 1. Query FeltDB for last known state
  const lastEvent = await feltdb.coordinator_events
    .orderBy("sequenceNumber")
    .last();
  
  // 2. Rebuild routing tables from event log
  if (lastEvent) {
    const events = await feltdb.coordinator_events.query({
      sequenceNumber: { $gt: lastEvent.sequenceNumber }
    });
    for (const event of events) {
      coordinatorState.apply(event);
    }
  }
  
  // 3. Notify clients to re-establish connections
  broadcastCoordinatorRecovered();
}
```

---

## FeltDB Capability Requirements

### Essential (for any adoption)

1. **Put/Get by Key**
   - Simple key-value storage
   - Atomic writes
   - Status: Available in FeltDB ✓

2. **Append-Only Events**
   - Insert-only semantics
   - Sequence ordering
   - Status: Need to evaluate FeltDB events collection

3. **Query/Index**
   - Filter by field values
   - Order by timestamp
   - Status: Need to evaluate FeltDB querying

### Nice-to-Have (for full adoption)

1. **Conditional Writes**
   - Put-if-absent (settings clash resolution)
   - Compare-and-swap (version control)
   - Status: Need to evaluate FeltDB capabilities

2. **Change Subscriptions**
   - Watch for setting changes
   - Status: Need to evaluate FeltDB subscriptions

3. **Batch Operations**
   - Atomic multi-key updates
   - Status: Need to evaluate

### Not Required

- Transactions (application can handle)
- SQL joins (collections are separate)
- Complex aggregations (app can compute)

---

## Migration Path: Phased Approach

### Phase 0: Discovery ✓ (This PR)
- [x] Audit current state management
- [x] Identify opportunities for FeltDB
- [x] Evaluate capability gaps
- [x] Get stakeholder alignment

### Phase 1: FeltDB Adapter (Low-Risk)
- [ ] Implement lightweight FeltDB client wrapper
- [ ] Add shadow-writes to one collection (e.g., usage_events)
- [ ] Verify durability works as expected
- [ ] No behavior changes

### Phase 2: Settings Optional Sync (Medium-Risk)
- [ ] Add optional settings sync to FeltDB
- [ ] Benchmark sync overhead
- [ ] Verify consistency
- [ ] Not yet used by coordinator (stays optional)

### Phase 3: Coordinator Optional Recovery (High-Value)
- [ ] Implement coordinator_events collection
- [ ] Test coordinator restart recovery
- [ ] Measure message loss (before/after)
- [ ] Enable if solves user-visible issue

### Phase 4: Dashboard/Analytics (Future)
- [ ] Defer until needed
- [ ] Use usage_events and session_metadata for queries
- [ ] Build analytics dashboard on FeltDB

### Phase 5: Cleanup (Polish)
- [ ] Remove deprecated shadow-write code
- [ ] Consolidate FeltDB integration into single adapter
- [ ] Update documentation

---

## Risk Assessment

### Low Risk
- **Settings sync** (read-only by FeltDB, JSON still authoritative)
- **Usage events** (append-only, no conflicts)
- **Session metadata** (read-only by FeltDB, SQLite still authoritative)

### Medium Risk
- **Coordinator recovery** (ephemeral state, but users expect coordinator to work)
- **Conditional writes** (need FeltDB support, requires testing)

### High Risk
- **Replacing SQLite** (NOT planned; SQLite is working well)
- **Removing JSON settings** (keep both until proven FeltDB is reliable)

---

## Explicit Non-Goals

### DO NOT DO

1. ❌ Replace SQLite databases with FeltDB
   - SQLite is working, durable, and per-session
   - Moving to FeltDB would lose session isolation
   - No performance benefit (both are local)

2. ❌ Store secrets in FeltDB
   - Keep all secrets in system keychain
   - Never persist provider API keys or tokens
   - FeltDB is not a secrets vault

3. ❌ Add complex transactions
   - App can handle cross-collection coordination
   - Optimize for simple, independent mutations
   - Use FeltDB for coordination, not complex logic

4. ❌ Migrate turn/transcript data
   - Keep SQLite for conversation data (it's working)
   - FeltDB for cross-session queries only (if needed)

---

**Document Status:** Initial Draft  
**Last Updated:** 2026-08-24  
**Next:** Create migration plan with concrete PRs
