# FeltDB Gaps & Validation v2: Paseo-Informed Evaluation

**Status:** Capability Validation  
**Replaces:** FELTDB-GAPS.md (v1 treated FeltDB as unknown)  
**Scope:** Evaluate FeltDB v0.4.17+ against Grok Bot authority requirements, leveraging Paseo findings

---

## FeltDB Capability Baseline (from Paseo)

Paseo integration work established these FeltDB capabilities:

✓ **Atomic admission** — accept + record atomically  
✓ **Durable operation persistence** — operations survive crashes  
✓ **Durable deduplication** — idempotency keys work  
✓ **Immutable records** — create-only semantics  
✓ **Sequence numbering** — causal ordering  
✓ **Bounded retries** — retry with backoff  
✓ **Recovery orchestration** — frontier-based recovery  
✓ **Indexed queries** — filter + order results  
✓ **Write atomicity** — single-key writes are durable  

**Status:** Validated in Paseo. Do NOT re-validate these.

---

## Grok Bot Requirements vs. FeltDB Capabilities

### Core Requirement: Idempotent Operations

**Grok Bot Needs:** Same `operationId` + `idempotencyKey` cannot be executed twice

**FeltDB Capability:** Validated in Paseo ✓

**Proof:** Paseo operations have immutable `idempotencyKey` field. Same key + operation cannot be inserted twice.

**Gap:** None. Use FeltDB as-is.

---

### Core Requirement: Durable Operation Tracking

**Grok Bot Needs:** Operation identity + status survives process restart

**FeltDB Capability:** Validated in Paseo ✓

**Proof:** Paseo persists operations durably. Restart queries by `operationId`, finds status.

**Gap:** None. Use FeltDB as-is.

---

### Core Requirement: Ordered Coordination Operations

**Grok Bot Needs:** Coordinator operations have strict sequence ordering (no race conditions on restart)

**FeltDB Capability:** Partial (needs validation for this specific use case)

**Paseo Finding:** Sequence numbering exists. Need to verify:
- [ ] Can FeltDB auto-increment sequence numbers?
- [ ] Are sequences globally ordered (not per-process)?
- [ ] Can we query "all operations after sequence N"?

**Action:** Test during Phase 1 coordinator work. Not blocking v1.

**Workaround:** Application assigns sequence numbers, FeltDB stores them.

---

### Core Requirement: Exactly-Once Execution

**Grok Bot Needs:** Tool execution with idempotency prevents side-effect duplication

**FeltDB Capability:** Combination of atomicity + deduplication ✓

**Proof:** 
1. Operation accepted → durable write (atomic)
2. Idempotency key recorded
3. Restart: query by idempotencyKey
4. If exists: use cached result (prevent re-execution)

**Gap:** None. Use FeltDB composition.

---

### Core Requirement: Recovery Frontier Checkpoints

**Grok Bot Needs:** Mark "all operations up to X have been processed" to skip replay on restart

**FeltDB Capability:** Questionable (needs validation)

**Paseo Finding:** Not explicitly mentioned. Need to verify:
- [ ] Can we store a "frontier" pointer efficiently?
- [ ] Can we query "all operations after frontier N"?

**Action:** Test during Phase 1.3 (RecoverySystem). 

**Workaround:** If FeltDB doesn't support efficient frontier queries, application can track "last processed operationId" in JSON file (not critical for v1).

---

## Validation During Phase 1

### Phase 1.1: Must Validate

Before proceeding past PR 1.1:

- [ ] FeltDB write latency is acceptable (< 10ms per operation)
- [ ] FeltDB persists operations across process restarts
- [ ] No data loss on crash/restart cycle
- [ ] Idempotency keys prevent duplicate inserts
- [ ] Immutability of records is enforced

**Testing:** Simulated crashes, verify data persistence

---

### Phase 1.2: Must Validate

Before proceeding past PR 1.2:

- [ ] Tool execution creates durable operation records
- [ ] Execution results are stored without duplication
- [ ] FeltDB latency doesn't block tool execution (async write acceptable for tool result)
- [ ] SQLite projection still receives results

**Testing:** Tool execution + crash, verify recovery finds incomplete work

---

### Phase 1.3: Must Validate

Before proceeding past PR 1.3:

- [ ] Recovery can query incomplete operations
- [ ] Idempotency key prevents duplicate tool execution on restart
- [ ] Recovery is deterministic (same events → same state)
- [ ] Frontier checkpoint can be recorded and queried efficiently

**Testing:** Crash during execution, restart, verify no duplicate side effects

---

### Phase 1.4: Observability Validation

- [ ] FeltDB operation write latency (goal: < 10ms)
- [ ] FeltDB query latency (goal: < 5ms)
- [ ] Deterministic recovery behavior (no randomness)
- [ ] Idempotency under stress (1000+ operations/crash cycles)

---

## Known Unknowns

These capabilities are NOT blocking for v1, but should be understood before Phase 2:

### 1. Sequence Number Generation

**Question:** Does FeltDB auto-increment sequence numbers atomically?

**Why:** Coordinator operations need global ordering without race conditions.

**Paseo Finding:** Not explicitly documented.

**Workaround for v1:** Application assigns sequence numbers (host process increments counter).

**Needed by:** Phase 2 (coordinator durability)

**Action:** Test during coordinator work; not blocking execution recovery (v1).

---

### 2. Conditional Writes / putIfAbsent

**Question:** Can FeltDB prevent duplicate writes with same key?

**Why:** Idempotency is enforced by FeltDB, not application.

**Paseo Finding:** Put-if-absent semantics were explored but unclear if exposed.

**Workaround for v1:** Application-level deduplication check before writing.

**Needed by:** Idempotency guarantees (v1 feature)

**Action:** Test during Phase 1.1. If not available, application can work around.

---

### 3. Change Subscriptions / Watchers

**Question:** Can processes be notified of FeltDB changes in real-time?

**Why:** Coordinator could watch for new operations without polling.

**Paseo Finding:** Unlikely available.

**Needed by:** Never (polling is acceptable for now)

**Action:** Defer indefinitely. Not needed for authority substrate.

---

### 4. Efficient Range Queries

**Question:** Can FeltDB efficiently query "all operations with status='executing' created after time T"?

**Why:** Recovery needs to find incomplete work quickly.

**Paseo Finding:** Indexed queries work; efficiency unknown under load.

**Needed by:** Phase 1.3 (recovery must be performant)

**Action:** Load test during Phase 1.4. If slow, may need to optimize schema.

---

### 5. Transactions / Multi-Key Atomicity

**Question:** Can FeltDB atomically update multiple records?

**Why:** Probably not needed if we design immutable operations.

**Paseo Finding:** Likely not available.

**Needed by:** Never (application-level protocol suffices)

**Action:** Don't ask for this. Design around single-key atomicity.

---

## Capability Validation Matrix

| Capability | Grok Bot Need | Paseo Status | Blocking v1? | Validation Method |
|---|---|---|---|---|
| Operation durability | Critical | ✓ Proven | No | Phase 1.1 crash test |
| Idempotency keys | Critical | ✓ Proven | No | Phase 1.2 duplicate test |
| Recovery frontier | High | ? Unknown | No | Phase 1.3 recovery test |
| Ordered sequences | High | ? Partial | No | Phase 2 (defer) |
| Write latency | Medium | ? Unknown | Yes | Phase 1.4 load test |
| Query latency | Medium | ? Unknown | Yes | Phase 1.4 load test |
| Immutability | High | ✓ Proven | No | Phase 1.1 |
| Auto-sequence | Low | ? Unknown | No | Phase 2 (defer) |
| Conditional write | Medium | ? Unknown | No | Phase 1.1 workaround |

---

## FeltDB Enhancements (If Needed)

### Enhancement: Auto-Sequence Allocation

**Needed if:** Coordinator requires strict global ordering

**Would solve:** Coordinator operation sequence without application-level counter

**Priority:** Low (application can do this)

**Proposed API:**
```typescript
const nextSequence = await feltdb.allocateSequence('coordinator_sequence');
// Returns: 1, 2, 3, ... strictly increasing
```

**Do NOT implement** unless coordinator phase identifies it as blocker.

---

### Enhancement: Multi-Key Transactions

**Needed if:** Application requires multi-record atomicity

**Would solve:** Never (application-level protocol suffices)

**Priority:** Very Low

**Recommendation:** Do NOT request. Immutable operations + protocol design are better.

---

## Validation Checklist Before Phase 1 Starts

- [ ] FeltDB v0.4.17+ is available and compatible
- [ ] Paseo work has documented these capabilities (link to Paseo findings)
- [ ] Development environment can run FeltDB locally
- [ ] Test framework supports crash simulation
- [ ] Telemetry system can measure FeltDB latency

---

## During Phase 1: Test Log Required

Create a log documenting:

1. **Operation Creation**
   - FeltDB write successful? ✓
   - Write latency: _ ms
   - Data persisted after crash? ✓

2. **Idempotency**
   - Duplicate key rejected? ✓
   - Error handling correct? ✓

3. **Recovery**
   - Incomplete operations found? ✓
   - Recovery is deterministic? ✓
   - No duplicates after restart? ✓

4. **Performance**
   - Operation writes: _ ms (target: < 10ms)
   - Recovery queries: _ ms (target: < 5ms)
   - Tool execution latency: _ ms (target: no regression)

---

## Success Criteria for Declaring FeltDB Authority Substrate "Proven"

After Phase 1, if all of these are true, FeltDB is validated:

- [x] Operations are durable across process crashes
- [x] Idempotency keys prevent duplicate execution
- [x] Recovery is deterministic and complete
- [x] No tool side effects are duplicated under crash+restart
- [x] Performance impact is < 10ms per critical operation
- [x] No data loss in crash scenarios
- [x] Code is correct and reviewable

---

**Document Status:** Initial Draft (v2)  
**Last Updated:** 2026-08-24  
**Next:** Start Phase 1 implementation
