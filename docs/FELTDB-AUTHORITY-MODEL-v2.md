# FeltDB Authority Model v2: Durable Operations Substrate

**Status:** Architecture Design—Aggregate-Based Authority Model  
**Replaces:** FELTDB-AUTHORITY-MODEL.md (v1 was too overlay-focused)  
**Scope:** FeltDB as cross-process durable authority for operations and recovery

---

## Core Concept: Durable Operations

Instead of shadowing state across boundaries, FeltDB models application work as **immutable durable operations**:

```
Operation accepted
  ↓
durable write to FeltDB
  ↓
runtime proceeds
  ↓
process can crash
  ↓
restart queries FeltDB
  ↓
operation discovered
  ↓
recovery continues or deduplicates
```

This is fundamentally different from "let's put some usage events in FeltDB."

---

## FeltDB Collections: Aggregate-Based Design

**NOT** a relational schema. Instead, model by **immutable aggregates and state machines**.

### 1. Operation Aggregate

**Purpose:** Track a unit of durable work accepted by the system

```typescript
interface Operation {
  // Identity
  operationId: string;        // UUID, globally unique
  kind: 'turn' | 'execution' | 'coordination';
  
  // Lifecycle
  status: 'accepted' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  
  // Idempotency
  idempotencyKey: string;     // caller-provided key (e.g., SHA-256(operationContent))
  
  // Authority
  authorityProcess: string;   // process ID that created this operation
  
  // Recovery
  checkpoint?: Uint8Array;    // state snapshot before execution
  resultSnapshot?: Uint8Array; // state snapshot after execution
  
  // Metadata
  metadata: JSON;             // operation-specific data
}
```

**Collection Name:** `operation`

**Semantics:**
- Insert-only initially
- Status can transition (accepted → executing → completed)
- **Same `operationId` + `idempotencyKey` cannot be re-executed**
- Transitions to terminal states (completed/failed) are permanent

**Indexing:**
- By `operationId` (lookup)
- By `status` (query pending operations)
- By `createdAt` (query by time range)
- By `authorityProcess` (recovery per process)

**Guarantees:**
- Durable write before acknowledgement
- Atomically idempotent
- Recoverable after crash

---

### 2. Execution Aggregate

**Purpose:** Track specific tool/sandbox execution with results

```typescript
interface Execution {
  // Identity
  executionId: string;        // UUID
  operationId: string;        // Which operation owns this
  
  // Execution details
  kind: 'tool' | 'subagent' | 'mcp_call';
  name: string;               // tool name, subagent type, etc.
  arguments: Uint8Array;      // serialized arguments
  
  // Result
  status: 'pending' | 'executing' | 'succeeded' | 'failed';
  result?: Uint8Array;        // serialized result
  error?: string;
  
  // Timestamps
  createdAt: number;
  executedAt?: number;
  completedAt?: number;
  
  // Recovery
  attemptCount: number;
  lastAttemptAt?: number;
}
```

**Collection Name:** `execution`

**Semantics:**
- Owned by parent operation
- Status machine: pending → executing → succeeded OR failed
- **Immutable idempotency: same executionId cannot succeed twice**
- Can retry with `attemptCount` increment, but result is idempotent

**Guarantee:**
- If execution reaches "succeeded" state, that result is permanent
- Restart cannot re-execute same execution

---

### 3. Recovery Checkpoint Aggregate

**Purpose:** Mark durable frontier for replay

```typescript
interface RecoveryCheckpoint {
  // Identity
  checkpointId: string;
  scope: 'application' | 'process' | 'session';
  
  // Frontier
  lastProcessedOperationId: string;
  lastProcessedSequence: number;
  
  // State
  frontier: Uint8Array;       // entire durable state snapshot at this frontier
  
  // Metadata
  createdAt: number;
  processId: string;
}
```

**Collection Name:** `recovery_checkpoint`

**Semantics:**
- Insert-only
- Marks "all operations up to X have been durably processed"
- Recovery starts from last checkpoint, replays operations after

**Guarantee:**
- Restart can skip operations already in checkpoint
- No duplicate work between checkpoint and current frontier

---

### 4. Coordinator Operation Aggregate

**Purpose:** Track routed coordination operations (streaming, message forwarding)

```typescript
interface CoordinatorOperation {
  // Identity
  operationId: string;        // UUID
  sequence: number;           // Global sequence number (causal ordering)
  
  // Operation
  kind: 'route' | 'stream' | 'acknowledge' | 'reaction';
  payload: JSON;              // operation-specific data
  
  // Status
  status: 'accepted' | 'in_flight' | 'acknowledged';
  
  // Recovery
  frontier: number;           // coordinator's last known frontier when this was created
  
  // Timestamps
  createdAt: number;
  acknowledgedAt?: number;
}
```

**Collection Name:** `coordinator_operation`

**Semantics:**
- Ordered by sequence number (strict causal ordering)
- Status transitions are durable
- Idempotent: same operation cannot execute twice

**Guarantee:**
- Coordinator restart can query for unacknowledged operations
- Can replay to rebuild routing state
- Sequence ordering enables deduplication

---

## State Machines & Atomicity

### Operation State Machine

```
          ┌─────────────┐
          │  accepted   │
          └──────┬──────┘
                 │
       ┌─────────▼──────────┐
       │    executing       │
       └─────────┬──────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
    ▼            ▼            ▼
completed      failed      cancelled
(terminal)    (terminal)   (terminal)
```

**Critical Atomicity Requirement:**

Transition to terminal state must be:
1. Durable (written to FeltDB first)
2. Atomic (cannot partially complete)
3. Idempotent (retry is safe)

**Implementation Pattern:**

```typescript
async function completeOperation(operationId, result) {
  // 1. Read current state
  const current = await feltdb.operation.get(operationId);
  if (current.status === 'completed') {
    return { status: 'already_completed', result: current.resultSnapshot };
  }
  
  // 2. Atomically update status + result
  const updated = {
    ...current,
    status: 'completed',
    resultSnapshot: result,
    completedAt: now(),
  };
  
  // 3. Write to FeltDB (must complete)
  await feltdb.operation.put(updated);
  
  // 4. Only then return success
  return { status: 'completed' };
}
```

If FeltDB write fails, operation is NOT considered complete. Caller must retry.

---

## Authority Boundary: What FeltDB Owns

### FeltDB = Authority

- Operation identity and lifecycle
- Execution idempotency
- Recovery frontier
- Coordination sequence
- **ALL mutations must be blocking (not fire-and-forget)**

### SQLite = Projection (Session-Local)

- Transcript entries (derived from operation results)
- Turn content (cached from operation state)
- **Queries are local, optimized for single-session performance**

### Process Memory = Ephemeral

- Active sockets
- Process handles
- In-flight streams
- UI state

---

## Recovery Protocol

### After Process Crash

```
1. Startup: Query FeltDB for last RecoveryCheckpoint
   → frontier = "all operations up to #N are done"

2. Query FeltDB for operations after frontier
   → List: [#N+1, #N+2, #N+3, ...]

3. For each incomplete operation:
   a. Check status in FeltDB
   b. If status = 'executing': check if result exists
   c. If result exists: skip execution, use cached result
   d. If no result: retry execution with idempotencyKey
   e. If execution fails: mark as failed, continue
   f. If execution succeeds: update operation status

4. Update RecoveryCheckpoint to new frontier

5. Resume normal operation
```

**Guarantees:**
- No duplicate execution (idempotency key prevents)
- All work is accounted for
- Recovery is deterministic and repeatable

---

## Mutation Rules: Blocking Authority Writes

### NEVER: Fire-and-Forget Authority Writes

```typescript
// WRONG - THIS VIOLATES AUTHORITY SEMANTICS
async function startExecution(executionId) {
  const execution = { executionId, status: 'executing' };
  
  // Fire-and-forget (BAD for authority)
  feltdb.execution.put(execution).catch(err => {
    log.warn('FeltDB write failed');
    // Application continues even though write failed!
  });
  
  // Caller thinks execution started, but FeltDB may not have it
  return { status: 'started' };
}
```

### RIGHT: Blocking Authority Writes

```typescript
// CORRECT - AUTHORITY REQUIRES BLOCKING
async function startExecution(executionId) {
  const execution = { executionId, status: 'executing' };
  
  // MUST wait for FeltDB write to complete
  try {
    await feltdb.execution.put(execution);
  } catch (err) {
    log.error('Failed to record execution start', err);
    throw err;  // Propagate error to caller
  }
  
  // Caller knows: execution is durable
  return { status: 'started' };
}
```

If FeltDB write fails, the caller must retry or fail the operation. The mutation is not considered complete until FeltDB acknowledges.

---

## Concurrency Model

### Single Writer Per Operation

```
Electron main
  ├─ Settings (RPC if needed)
  │
Host process
  ├─ Operations (primary writer)
  ├─ Executions (primary writer)
  ├─ Recovery checkpoints (writer)
  │
Coordinator
  ├─ Coordinator operations (primary writer)
```

**Concurrency Guarantee:**

Each operation has a single authoritative writer (host or coordinator). No concurrent mutations. Prevents write conflicts.

**If multiple processes need to update same operation:**

Use operation metadata + explicit coordination. Example:

```typescript
// Host updates operation status
async function advanceOperationStatus(operationId, newStatus) {
  const current = await feltdb.operation.get(operationId);
  
  // Read-modify-write with version check
  if (current.version !== expectedVersion) {
    throw new Error('Concurrent update detected');
  }
  
  await feltdb.operation.put({
    ...current,
    status: newStatus,
    version: current.version + 1,
  });
}
```

FeltDB's immutable record design supports this via versioning or put-if-version.

---

## What NOT To Do

### Don't Invent EventLog Collection

Can ordinary FeltDB operation collection provide event semantics? Yes:
- Immutable records (create-only)
- Indexed by sequence/timestamp
- Queryable by status
- Replay from checkpoint

**Don't need special `EventLog` type.** Use operation collection.

### Don't Create Complex Schema

Avoid:
```
settings
sessions
turns
tool_calls
usage_events
```

Instead, model by **aggregates that exist as business concepts**:
```
operation (durable unit of work)
execution (tool/function invocation)
coordination (router/streaming operation)
recovery_checkpoint (frontier marker)
```

### Don't Use Transactions

We don't need:
```typescript
feltdb.transaction(async (tx) => {
  await tx.put(...);
  await tx.put(...);
});
```

Instead, design mutation protocols:
1. Accept operation (durable write)
2. Execute
3. Complete operation (durable write)
4. Update checkpoint

Each step is an independent, durable, atomic write. No multi-key transactions needed.

### Don't Shadow-Write For Authority

All FeltDB authority writes must be blocking. Fire-and-forget is only for:
- Telemetry
- Audit logs
- Non-critical observability

---

## Vertical Slice: Execution Recovery

**First implementation should prove:**

1. **FeltDB operation creation is durable**
   - Host creates operation, writes to FeltDB, receives ack
   - Even if host crashes immediately after, operation persists

2. **Idempotency prevents duplicate execution**
   - Same executionId cannot be executed twice
   - Restart queries FeltDB, finds existing execution, skips re-run

3. **Recovery finds incomplete operations**
   - Restart scans FeltDB for operations with status='executing'
   - Determines: retry, use cached result, or mark failed

4. **Tool execution is exactly-once**
   - Even with kill -9 mid-execution, no duplicate side effects

If this vertical slice works, FeltDB has proven its value as authority substrate.

---

**Document Status:** Initial Draft (v2)  
**Replaces:** FELTDB-AUTHORITY-MODEL.md (v1)  
**Next:** Implement Phase 1 (vertical slice)
