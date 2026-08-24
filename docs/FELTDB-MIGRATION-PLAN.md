# FeltDB Migration Plan

Phased approach to introducing FeltDB as an optional coordination layer.

## Phase 0: Discovery & Evaluation ✓ (COMPLETE)

**Goal:** Understand current authority model and identify FeltDB opportunities

**Deliverables:**
- [x] FELTDB-AUTHORITY-EVALUATION.md
- [x] FELTDB-AUTHORITY-MAP.md  
- [x] FELTDB-AUTHORITY-MODEL.md
- [x] This plan document
- [x] FELTDB-GAPS.md (pending)

**Key Findings:**
- SQLite is already the authority substrate for per-session data
- FeltDB would supplement (not replace) for cross-process coordination
- Coordinator state is ephemeral (could benefit from durability)
- Usage records could be audit-logged separately

**Recommendation:** Proceed with Phases 1-2 (low-risk adoption)

---

## Phase 1: FeltDB Adapter Foundation

**Duration:** 2-3 weeks  
**Risk:** Low  
**Scope:** Infrastructure, no behavior changes  
**PR Count:** 2-3 PRs

### PR 1.1: Add FeltDB Dependency & Basic Client

**Goal:** Integrate FeltDB as a runtime dependency with minimal footprint

**Changes:**
- Add `@feltdb/core` to package.json
- Create `source/packages/feltdb-adapter/` module
- Implement lightweight FeltDB client wrapper
  - Connection management
  - Error handling
  - Logging/telemetry

**Example Structure:**
```typescript
// source/packages/feltdb-adapter/feltdb-client.ts
export interface FeltDBConfig {
  rootPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class FeltDBAdapter {
  private db: FeltDB;
  
  async initialize(config: FeltDBConfig): Promise<void>;
  async shutdown(): Promise<void>;
  
  // Collections
  readonly globalSettings: FeltDBCollection<GlobalSetting>;
  readonly usageEvents: FeltDBCollection<UsageEvent>;
  readonly coordinatorEvents?: FeltDBCollection<CoordinatorEvent>;
  readonly sessionMetadata?: FeltDBCollection<SessionMetadata>;
}

export function createFeltDBAdapter(config: FeltDBConfig): FeltDBAdapter;
```

**Testing:**
- Unit tests for adapter initialization
- Tests for error recovery
- Tests for connection lifecycle

**Success Criteria:**
- FeltDB initializes without errors
- Can read/write to a test collection
- Shutdown is clean (no resource leaks)

---

### PR 1.2: Integrate FeltDB Adapter into Host Process

**Goal:** Wire FeltDB into host process lifecycle

**Changes:**
- Electron main creates FeltDB adapter instance
- Pass FeltDB instance to host process
- Add FeltDB cleanup on shutdown

**Example Integration:**
```typescript
// source/electron-main/main.ts
async function start() {
  const feltdbConfig: FeltDBConfig = {
    rootPath: app.getPath('userData'),
    logLevel: config.debug ? 'debug' : 'info',
  };
  
  const feltdb = createFeltDBAdapter(feltdbConfig);
  await feltdb.initialize();
  
  // Pass to host process
  const host = await launchHost({ feltdb });
  
  app.on('quit', async () => {
    await host.shutdown();
    await feltdb.shutdown();
  });
}
```

**Changes to Host:**
- Accept FeltDB instance from main
- Store as accessible service
- Add simple health check

**Testing:**
- Integration test: FeltDB + Host startup
- Test shutdown cleanup
- Verify FeltDB directory is created

**Success Criteria:**
- Host and FeltDB start together
- No crashes during initialization
- Clean shutdown

---

### PR 1.3: Add FeltDB Telemetry & Observability

**Goal:** Understand FeltDB performance and behavior

**Changes:**
- Add metrics for FeltDB operations
  - Write latency
  - Read latency
  - Error counts
- Add structured logging
- Create simple dashboard/status page

**Example Metrics:**
```typescript
const feltdbWriteLatency = createHistogram('feltdb.write.duration_ms');
const feltdbReadLatency = createHistogram('feltdb.read.duration_ms');
const feltdbErrors = createCounter('feltdb.errors');
```

**Testing:**
- Verify metrics are collected
- Check logging output format
- Test error handling path

**Success Criteria:**
- Metrics are being recorded
- Logs are structured and queryable
- No performance regression

---

## Phase 2: Usage Events (First Real Use)

**Duration:** 3-4 weeks  
**Risk:** Low  
**Scope:** Append-only event log for usage  
**PR Count:** 2-3 PRs

### PR 2.1: Shadow-Write Usage Events to FeltDB

**Goal:** Start collecting usage data in FeltDB without changing behavior

**Changes:**
- Create `usage_events` collection schema
- Modify inference router to append events to FeltDB
- Keep settings JSON as authoritative source
- Add feature flag to enable/disable FeltDB writes

**Example Code:**
```typescript
// In inference router (e.g., src/host/router.ts)
async function recordUsageEvent(event: UsageEvent) {
  // Existing behavior (unchanged)
  usageAccumulator.add(event);
  
  // New: Shadow-write to FeltDB
  if (config.feltdbEnabled) {
    feltdb.usageEvents.put({
      eventId: generateUUID(),
      timestamp: now(),
      ...event,
    }).catch(err => {
      log.warn('Failed to record usage event in FeltDB', { err });
      // Non-blocking: continue even if FeltDB fails
    });
  }
}
```

**Feature Flags:**
- `FELTDB_ENABLED=true` to enable shadow-writes
- Default false (opt-in during testing)

**Testing:**
- Shadow-write doesn't block main flow
- Verify events appear in FeltDB
- Test with feature flag on/off
- Benchmark write latency

**Success Criteria:**
- Usage events recorded in FeltDB
- Settings JSON still authoritative
- No performance regression
- Feature flag works

---

### PR 2.2: Validate Usage Events Consistency

**Goal:** Verify FeltDB events match settings totals

**Changes:**
- Add validation routine that:
  1. Reads usage events from FeltDB
  2. Computes totals (requests, tokens, etc.)
  3. Compares to settings JSON totals
  4. Reports discrepancies
- Add telemetry for consistency checks
- Add test mode to validate on startup

**Example Code:**
```typescript
async function validateUsageConsistency(): Promise<ValidationResult> {
  const settingsTotal = settingsStore.getInferenceRouterUsage();
  
  const events = await feltdb.usageEvents.query({
    timestamp: { $gte: consistencyWindow }
  });
  
  const computedTotal = computeTotals(events);
  
  const diff = subtractUsage(settingsTotal, computedTotal);
  
  if (Math.abs(diff.requests) > TOLERANCE) {
    return { status: 'MISMATCH', diff };
  }
  
  return { status: 'OK' };
}
```

**Testing:**
- Validation passes when data is consistent
- Validation fails when intentionally inconsistent
- Telemetry is recorded correctly

**Success Criteria:**
- Validation runs without errors
- Consistency check is reliable
- Discrepancies are logged
- No performance impact

---

### PR 2.3: Read Usage Totals from FeltDB (Optional)

**Goal:** Demonstrate FeltDB as authoritative source (if needed)

**Changes:**
- Add alternative code path to compute usage from FeltDB events
- Add feature flag to switch reading from FeltDB vs. settings
- Default still settings (JSON), but FeltDB is tested alternative

**Only if Phase 2 confidence is high**

---

## Phase 3: Coordinator Recovery (High-Value)

**Duration:** 4-6 weeks  
**Risk:** Medium (coordinator reliability)  
**Scope:** Durable message queue for coordinator  
**PR Count:** 2-3 PRs

### PR 3.1: Coordinator Events Collection Schema

**Goal:** Define durable event log for coordinator

**Changes:**
- Create `coordinator_events` FeltDB collection
- Schema includes: eventId, sequenceNumber, timestamp, eventType, payload
- Add indexes for querying (by sequence number, timestamp)

**Schema:**
```typescript
interface CoordinatorEvent {
  eventId: string; // UUID
  sequenceNumber: number; // Coordinator's global sequence
  timestamp: number; // ms since epoch
  eventType: 'route' | 'stream_open' | 'stream_close' | 'reaction' | 'message';
  payload: JSON; // Event-specific data
  acknowledgments?: string[]; // Client IDs that acked
}
```

**Testing:**
- Collection creation succeeds
- Schema validation works
- Indexes are created
- Query by sequenceNumber works

**Success Criteria:**
- Collection exists and is queryable
- Indexes improve query performance
- Schema enforces structure

---

### PR 3.2: Shadow-Write Coordinator Events

**Goal:** Start logging coordinator events (non-blocking)

**Changes:**
- Coordinator appends events to FeltDB on each action
- Fire-and-forget (don't block on FeltDB write)
- Add feature flag to enable

**Example Code:**
```typescript
// In coordinator event handler
async function handleCoordinatorEvent(event: CoordinatorEvent) {
  // 1. Process immediately (blocking)
  await coordinatorState.apply(event);
  
  // 2. Log to FeltDB (non-blocking)
  if (config.feltdbEnabled) {
    feltdb.coordinatorEvents.put({
      eventId: generateUUID(),
      sequenceNumber: ++sequenceCounter,
      timestamp: now(),
      ...event,
    }).catch(err => {
      log.warn('Failed to log coordinator event', err);
      // Continue even if FeltDB fails
    });
  }
}
```

**Testing:**
- Events are logged to FeltDB
- Coordinator works even if FeltDB fails
- No latency regression
- Feature flag on/off works

**Success Criteria:**
- Coordinator events recorded in FeltDB
- Coordinator remains responsive
- No message loss in normal operation

---

### PR 3.3: Coordinator Recovery from FeltDB

**Goal:** Replay events on coordinator restart

**Changes:**
- On coordinator startup: query FeltDB for events since last checkpoint
- Replay events to rebuild routing state
- Clients re-connect (they expect coordinator to be fresh anyway)
- Test recovery under various crash scenarios

**Example Code:**
```typescript
async function recoverCoordinatorState() {
  try {
    // Find last known checkpoint
    const lastCheckpoint = coordinatorState.getLastCheckpoint();
    
    // Query events since checkpoint
    const events = await feltdb.coordinatorEvents.query({
      sequenceNumber: { $gt: lastCheckpoint.sequence }
    });
    
    // Replay events in order
    for (const event of events) {
      await coordinatorState.apply(event);
    }
    
    log.info('Coordinator recovered from FeltDB', {
      eventsReplayed: events.length
    });
  } catch (err) {
    log.error('Coordinator recovery failed, starting fresh', { err });
    // Fallback: start fresh (clients reconnect anyway)
  }
}
```

**Testing:**
- Coordinator recovers after kill -9
- Routing tables are rebuilt correctly
- Clients can reconnect
- No message loss (except during crash window)

**Success Criteria:**
- Coordinator recovers from crash
- Routing state is correct after replay
- Clients reconnect successfully
- User doesn't notice coordinator restart

---

## Phase 4: Dashboard & Analytics (Future)

**Duration:** TBD  
**Risk:** Low  
**Scope:** Cross-session queries  
**PR Count:** 2-3 PRs (when needed)

**Defer until:**
- Usage events are stable in FeltDB
- Cross-session queries are needed for product feature
- Analytics dashboard is prioritized

**Potential PRs:**
- PR 4.1: Add `session_metadata` collection
- PR 4.2: Sync session metadata from SQLite to FeltDB
- PR 4.3: Analytics queries & dashboard

---

## Phase 5: Settings Migration (Optional)

**Duration:** 3-4 weeks  
**Risk:** Medium (changes fundamental settings authority)  
**Scope:** Centralize settings authority in FeltDB  
**PR Count:** 3-4 PRs (only if needed)

**Defer unless:**
- Coordinator needs settings without going through Electron main
- Settings conflicts need global coordination
- JSON file approach is insufficient

**Potential PRs:**
- PR 5.1: Shadow-write settings to FeltDB
- PR 5.2: Validate settings consistency
- PR 5.3: Switch reads to FeltDB (with feature flag)
- PR 5.4: Remove JSON file if confidence high

---

## Phase 6: Cleanup & Polish (TBD)

**Duration:** 1-2 weeks  
**Risk:** Low  
**Scope:** Remove technical debt, consolidate  
**PR Count:** 1-2 PRs

**Defer until:**
- Multiple phases are complete & stable
- FeltDB is proven reliable
- Technical debt is significant

---

## PR Dependencies & Ordering

```
Phase 1: Foundation
  PR 1.1 (Add FeltDB)
    ↓
  PR 1.2 (Integrate into host)
    ↓
  PR 1.3 (Telemetry) [parallel to above]

Phase 2: Usage Events
  PR 2.1 (Shadow-write usage)
    ↓
  PR 2.2 (Validate consistency)
    ↓
  PR 2.3 (Read from FeltDB, optional)

Phase 3: Coordinator
  PR 3.1 (Events schema)
    ↓
  PR 3.2 (Shadow-write events)
    ↓
  PR 3.3 (Recovery)

Phase 4+: Defer until needed
```

---

## Rollback Strategy

If FeltDB causes issues:

1. **Phase 1 Rollback:**
   - Remove FeltDB initialization from main
   - Delete adapter module
   - Revert to previous branch

2. **Phase 2 Rollback:**
   - Set `FELTDB_ENABLED=false` (feature flag)
   - Coordinator stays durable in settings JSON
   - Delete FeltDB usage events (can reconstruct from settings)

3. **Phase 3 Rollback:**
   - Set `FELTDB_COORDINATOR_ENABLED=false`
   - Coordinator reverts to ephemeral (clients expect restart anyway)
   - Events are not replayed (acceptable)

**All phases are non-blocking:** FeltDB failures don't crash the app. Worst case is loss of FeltDB benefits, app continues to work.

---

## Testing & Validation

### Unit Tests (per PR)
- FeltDB adapter initialization
- Event serialization/deserialization
- Validation logic (consistency checks)
- Error handling paths

### Integration Tests (per phase)
- Phase 1: FeltDB + Host start/shutdown
- Phase 2: Usage events recorded and queryable
- Phase 3: Coordinator recovery after kill -9

### Stress Tests (Phase 3+)
- Kill coordinator every N seconds, verify recovery
- Flood with events, verify ordering
- Run with high CPU/memory pressure

### User-Visible Tests
- No regression in turn execution
- No lag in UI
- Settings changes still work
- No unusual errors in logs

---

## Success Criteria by Phase

### Phase 1
- [ ] FeltDB initializes without errors
- [ ] No performance regression
- [ ] Telemetry shows healthy FeltDB operation
- [ ] Clean shutdown

### Phase 2
- [ ] Usage events are recorded in FeltDB
- [ ] Validation shows consistency
- [ ] Telemetry shows event write latency
- [ ] Feature flag works (on/off)

### Phase 3
- [ ] Coordinator events are logged
- [ ] Coordinator recovery works after crash
- [ ] Clients reconnect successfully
- [ ] No message loss (except during crash)

### Phase 4
- [ ] Cross-session queries are possible
- [ ] Analytics dashboard loads
- [ ] No impact on single-session performance

---

## Known Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| FeltDB crashes app | High | Make all FeltDB writes non-blocking; wrap in try-catch |
| FeltDB disk full | Medium | Implement bounded admission; warn before quota |
| FeltDB is slow | Medium | Profile per phase; don't adopt if latency > threshold |
| FeltDB loses data | High | Validate events vs. authoritative source (settings) |
| Users upgrade, FeltDB incompatible | Medium | Versioning & migration protocol in FeltDB |
| Coordinator recovery is incomplete | Medium | Test extensively; accept some message loss is ok |

---

**Document Status:** Initial Draft  
**Last Updated:** 2026-08-24  
**Next:** Implement Phase 1.1
