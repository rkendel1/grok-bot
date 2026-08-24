# FeltDB Gaps & Substrate Evaluation

Evaluation of FeltDB capabilities required for Grok Bot adoption vs. capabilities that Paseo discovered.

---

## FeltDB Capabilities Matrix

| Capability | Grok Bot Needs | Paseo Found Gap? | Current Status | Implementation Effort |
|---|---|---|---|---|
| **Put/Get by Key** | Essential | No | Available ✓ | N/A |
| **Durable Blobs** | No (SQLite) | N/A | Available ✓ | N/A |
| **Append-Only Events** | High (usage, coordinator) | Partial? | **Needs eval** | TBD |
| **Indexed Queries** | Medium (cross-session) | Partial? | **Needs eval** | TBD |
| **Query Ordering** | Medium (by timestamp) | Yes | **Needs eval** | TBD |
| **Conditional Writes** | Low (optional) | Yes | **Needs eval** | Medium |
| **Transactions** | Low (not essential) | Yes | **Needs eval** | High |
| **Change Subscriptions** | Low (optional) | Yes | **Needs eval** | Medium |

---

## Essential Capabilities (Must Have)

### 1. Put/Get by Key

**What Grok Bot Needs:**
```
Write: feltdb.global_settings.put({ key, value, version, ... })
Read:  value = feltdb.global_settings.get(key)
```

**Status:** ✓ Available in FeltDB

**Confidence:** High

**Notes:** Basic KV store operations. FeltDB supports this.

---

### 2. Append-Only Events (or Create-Only)

**What Grok Bot Needs:**
```
Append: feltdb.usage_events.put({ eventId, timestamp, ... })
Query:  events = feltdb.usage_events.query({ timestamp: $gte: ... })
```

**Current FeltDB Status:** NEEDS EVALUATION

**Questions:**
- Can FeltDB support insert-only semantics?
- Does FeltDB guarantee ordering by insertion order or by index?
- Can updates be prevented (immutable events)?
- How to handle duplicate eventIds (idempotency)?

**Why Grok Bot Needs This:**
- Usage event log (audit trail)
- Coordinator event log (for recovery)
- Append-only is essential for event sourcing

**Paseo Finding:** Event sourcing was a gap in Paseo's research. Need to verify current FeltDB support.

**Implementation Effort if Missing:** High (requires new collection type or guarantees)

---

### 3. Query with Filtering & Ordering

**What Grok Bot Needs:**
```
query({ 
  timestamp: { $gte: since_time },
  eventType: { $eq: 'request' },
  provider: { $eq: 'claude' }
})
.orderBy('timestamp')
.limit(100)
```

**Current FeltDB Status:** NEEDS EVALUATION

**Questions:**
- Can FeltDB filter by field value?
- Can FeltDB order results?
- How expensive are these queries?
- What indexes are supported?

**Why Grok Bot Needs This:**
- Usage analytics (filter by time range, provider)
- Coordinator recovery (find events since sequence number)
- Session metadata queries (find agents created after date)

**Paseo Finding:** Indexed queries may be partial in FeltDB. Need to verify filtering & ordering support.

**Implementation Effort if Missing:** High (requires query engine)

---

## High-Priority Capabilities (Should Have)

### 4. Idempotent Writes (Put-If-Absent or Versioning)

**What Grok Bot Needs:**
```
// Option A: Idempotent append
put_if_absent(id, value)  // Only if id doesn't exist

// Option B: Version checking
put_if_version(id, value, expectedVersion)  // CAS
```

**Current FeltDB Status:** NEEDS EVALUATION

**Questions:**
- Does FeltDB support put-if-absent?
- Does FeltDB support compare-and-swap?
- What happens if write fails (error, silent no-op)?
- Can this be done atomically across multiple keys?

**Why Grok Bot Needs This:**
- Usage events: avoid duplicates if write is retried
- Coordinator events: exactly-once semantics
- Settings: prevent concurrent changes

**Paseo Finding:** Compare-and-swap was needed for Paseo's coordination use cases. Likely a gap.

**Impact if Missing:** Medium (can work around with application-level deduplication)

**Workaround:**
```typescript
// Application-level deduplication
const written = new Set<string>();
if (!written.has(eventId)) {
  await feltdb.usageEvents.put(event);
  written.add(eventId);
}
```

**Implementation Effort if Missing:** Medium (add CAS semantics to FeltDB)

---

## Medium-Priority Capabilities (Nice-to-Have)

### 5. Change Subscriptions / Watches

**What Grok Bot Needs:**
```
const unsubscribe = feltdb.global_settings.subscribe('*', (event) => {
  console.log('Setting changed:', event.key, event.newValue);
});
```

**Current FeltDB Status:** NEEDS EVALUATION

**Questions:**
- Can FeltDB push notifications on writes?
- Is this a subscription model or polling?
- What's the latency?
- Can you filter (only watch specific keys)?

**Why Grok Bot Needs This:**
- Coordinator updates routing state: others could watch
- Settings change: notify host without polling
- Real-time dashboard updates

**Paseo Finding:** Subscriptions were likely a gap. FeltDB may not have push semantics.

**Impact if Missing:** Low (can poll or use feature flags)

**Workaround:**
```typescript
// Poll every N seconds
setInterval(async () => {
  const current = await feltdb.global_settings.get('inference_provider');
  if (current !== last) {
    emit('settingChanged', 'inference_provider', current);
    last = current;
  }
}, 1000);
```

**Implementation Effort if Missing:** Medium (requires durable change notification queue)

---

## Low-Priority Capabilities (Optional)

### 6. Transactions / Multi-Key Atomic Updates

**What Grok Bot Needs:**
```
feltdb.transaction(async (tx) => {
  await tx.put('key1', value1);
  await tx.put('key2', value2);
  // All-or-nothing
});
```

**Current FeltDB Status:** NEEDS EVALUATION

**Questions:**
- Are transactions supported?
- What isolation level?
- Timeout/rollback behavior?

**Why Grok Bot Needs This:**
- Complex state mutations that must be all-or-nothing
- Example: update both usage count AND last-used timestamp together

**Impact if Missing:** Low (very rare in Grok Bot's use cases)

**Workaround:**
```typescript
// Application-level coordination
await feltdb.put('usage_count', count + 1);
await feltdb.put('last_used_at', now());
// If second fails, count is already incremented (eventually consistent)
```

**Implementation Effort if Missing:** High (requires ACID semantics)

**Recommendation:** DON'T wait for this. App can live with eventual consistency.

---

## Known Gaps from Paseo Research

| Gap | Severity | Impact on Grok Bot | Recommendation |
|---|---|---|---|
| Event sourcing unclear | Medium | Needed for usage log | Evaluate before Phase 2 |
| Indexing limited | Medium | Needed for queries | Evaluate before Phase 4 |
| CAS not found | High | Needed for idempotency | Consider application-level dedup |
| Subscriptions missing | Low | Nice for real-time | Can use polling |
| No transactions | Medium | Not critical | Can work around |

---

## Evaluation Checklist

Before committing to each phase, verify FeltDB capabilities:

### Phase 1 (Foundation) - REQUIRED
- [ ] FeltDB Put/Get works reliably
- [ ] FeltDB handles errors correctly
- [ ] No performance regression (<5ms latency)
- [ ] Data persists across restarts

### Phase 2 (Usage Events) - REQUIRED
- [ ] FeltDB supports append-only semantics
- [ ] FeltDB can query by field (timestamp)
- [ ] FeltDB can order results by timestamp
- [ ] Event ordering is deterministic
- [ ] Idempotent writes or application dedup works

### Phase 3 (Coordinator) - REQUIRED
- [ ] FeltDB can store ~1KB events
- [ ] FeltDB can query by sequence number
- [ ] Event ordering preserved
- [ ] Query performance is acceptable for recovery replay

### Phase 4 (Dashboard) - OPTIONAL
- [ ] FeltDB can handle complex queries
- [ ] Aggregation queries are fast enough
- [ ] Cross-table joins not needed (use application layer)

---

## Proposed FeltDB Enhancement PRs

If FeltDB gaps are found, propose these (in priority order):

### PR FeltDB-1: Append-Only Event Collection

**Solves:** Append-only semantics for usage events  
**Complexity:** Medium  
**Priority:** High (blocker for Phase 2)

```typescript
// New collection type: EventLog
const log = new EventLog('usage_events');

// Properties:
// - Insert-only (no updates)
// - Auto-assigned sequence numbers
// - Guaranteed ordering
// - Query by range (seq > N)

log.append({ eventId, timestamp, ... });
log.query({ seq: { $gt: 100 } });
```

---

### PR FeltDB-2: Query Filtering & Ordering

**Solves:** Field-level filtering, sorting  
**Complexity:** High  
**Priority:** High (blocker for Phase 2+)

```typescript
// Enhanced query API
feltdb.collection
  .query({
    timestamp: { $gte: minTime, $lte: maxTime },
    provider: { $in: ['claude', 'cursor'] },
  })
  .orderBy('timestamp', 'desc')
  .limit(100);
```

---

### PR FeltDB-3: Conditional Write (Compare-And-Swap)

**Solves:** Idempotent writes, version control  
**Complexity:** Medium  
**Priority:** Medium (nice-to-have, can work around)

```typescript
// CAS: Compare-And-Swap
feltdb.putIfVersion(key, newValue, expectedVersion);
// Returns: { success: true, newVersion } or { success: false, currentVersion }
```

---

### PR FeltDB-4: Change Subscriptions

**Solves:** Real-time change notifications  
**Complexity:** High  
**Priority:** Low (can use polling)

```typescript
// Watch for changes
feltdb.subscribe('global_settings', ['*'], (event) => {
  console.log('Changed:', event);
});
```

---

## Comparison to Paseo

### Paseo's Findings (Summarized)

Paseo discovered FeltDB was useful for:
- ✓ Durable state (KV + blobs)
- ✓ Recovery semantics (crash safety)
- ? Event sourcing (uncertain support)
- ? Change subscriptions (not found)
- ✗ Transactions (not found)

### Grok Bot's Needs (Aligned with Paseo)

Grok Bot needs:
- ✓ Durable state → FeltDB KV (Phase 1)
- ✓ Recovery semantics → Can add coordinator recovery (Phase 3)
- ? Event sourcing → Usage events need append-only (Phase 2 blocker)
- ? Change subscriptions → Settings sync optional (Phase 5+)
- ✗ Transactions → Not needed (can work around)

**Alignment:** Grok Bot's requirements are consistent with Paseo's findings. Same gaps exist.

---

## Decision Matrix

| Phase | Blocker Gap | Can Proceed? | Workaround |
|---|---|---|---|
| Phase 1 | None | YES | N/A |
| Phase 2 | Append-only events | MAYBE | Use regular Put (less efficient, but works) |
| Phase 3 | Query ordering | YES | Application-side sorting (slower) |
| Phase 4 | Indexed queries | MAYBE | Fetch all, filter in app (slow for large sets) |

**Recommendation:** Proceed with Phase 1 immediately. Evaluate Phase 2 blockers before starting.

---

## FeltDB Capability Questions to Answer

When evaluating FeltDB implementation:

### 1. Event Ordering
```
Q: If I write events with sequence numbers in FeltDB,
   and query { seq: { $gt: 100 } },
   are results guaranteed ordered by sequence number?
A: ???
```

### 2. Idempotency
```
Q: If I write { id: 'event-1', data: ... } twice,
   do I get two entries or one?
A: ???
```

### 3. Query Performance
```
Q: What's the latency for:
   query({ timestamp: { $gte: since } }).orderBy('timestamp')?
   - <1ms?
   - <10ms?
   - <100ms?
A: ???
```

### 4. Subscriptions
```
Q: Can I watch for changes on a collection?
   Do I get a callback when data changes?
A: ???
```

### 5. Concurrent Access
```
Q: If two processes write to FeltDB simultaneously,
   are writes serialized or concurrent?
A: ???
```

---

**Document Status:** Initial Draft  
**Last Updated:** 2026-08-24  
**Next:** Run Grok Bot with Phase 1 to test FeltDB integration

---

## Appendix: Comparison Table

### FeltDB Capabilities vs. Grok Bot Needs

| Capability | Grok Bot Need | Why | FeltDB Support | Gap? |
|---|---|---|---|---|
| KV Put/Get | Essential | Settings, metadata | Yes ✓ | No |
| Blobs | No | SQLite used | Yes ✓ | No |
| Append | High | Event logging | Unknown | Maybe |
| Query filter | Medium | Analytics | Unknown | Maybe |
| Order results | Medium | Event replay | Unknown | Maybe |
| CAS/Version | Medium | Idempotency | Unknown | Maybe |
| Transactions | Low | Complex mutations | Unknown | Yes |
| Subscriptions | Low | Real-time updates | Unknown | Maybe |

---

## Next Steps

1. **Phase 1 Implementation:** Start immediately (no FeltDB gaps expected)
2. **Phase 2 Evaluation:** Before Phase 2, verify append-only semantics
3. **FeltDB Enhancement:** If gaps found, propose enhancements to FeltDB team
4. **Async Dependency:** Don't block Grok Bot on FeltDB; use workarounds

---

**Owner:** Grok Bot Architecture  
**Related:** FeltDB Enhancement Proposals, Paseo Research  
**Review Needed:** FeltDB Team (capability verification)
