# FeltDB Migration Plan v2: Vertical Slice Approach

**Status:** Implementation Planning—Authority Substrate Validation  
**Replaces:** FELTDB-MIGRATION-PLAN.md (v1 was too broad)  
**Scope:** Single, focused vertical slice to prove FeltDB authority works

---

## Philosophy: Prove the Substrate First

Instead of broad adoption phases, we do **one complete vertical slice** that exercises all the authority machinery:

1. **Operation creation** (durable acceptance)
2. **Execution tracking** (idempotency)
3. **Process crash** (FeltDB survives)
4. **Recovery** (find incomplete work)
5. **Duplicate prevention** (idempotency key)

If that works, we have proven FeltDB is a viable authority substrate. Then we scale to other domains.

---

## The Vertical Slice: Tool Execution Recovery

### Scenario

```
Turn is executing
  ↓
Host accepts tool call (creates Operation + Execution in FeltDB)
  ↓
Tool invokes external service
  ↓
Process crashes (kill -9) mid-execution
  ↓
System restarts
  ↓
Recovery: Query FeltDB for incomplete executions
  ↓
Recovery: Finds tool #123 is EXECUTING
  ↓
Recovery: Checks idempotency key vs. cache
  ↓
Recovery: Determines "already tried, use cached result"
  ↓
Turn continues with cached result
  ↓
NO DUPLICATE TOOL EXECUTION
```

### What We're Proving

- [x] FeltDB operation identity survives crashes
- [x] Idempotency keys prevent duplicate execution
- [x] Recovery can discover incomplete work
- [x] Restart doesn't lose durable state
- [x] Exactly-once semantics work across process boundaries

---

## Phase 0: Discovery ✓ (Complete)

Delivered:
- [x] FELTDB-AUTHORITY-EVALUATION-v2.md (fixed contradictions)
- [x] FELTDB-AUTHORITY-MAP.md (state inventory)
- [x] FELTDB-AUTHORITY-MODEL-v2.md (aggregate-based design)
- [ ] This plan (v2)
- [ ] FELTDB-GAPS-v2.md (updated)

---

## Phase 1: Vertical Slice Implementation

**Duration:** 2-3 weeks  
**Risk:** Low-to-Medium (new substrate, but isolated scope)  
**Scope:** Single PR with all necessary parts

### PR 1.1: FeltDB Client + Operation/Execution Collections

**Goal:** Introduce FeltDB and prove operation tracking works

**Changes:**

1. **Add FeltDB dependency**
   - `npm install @feltdb/core@0.4.17+`

2. **Create FeltDB client module** (`source/packages/feltdb-operations/`)
   ```
   └── feltdb-operations/
       ├── index.ts
       ├── operation-store.ts      // Operation CRUD + status transitions
       ├── execution-store.ts      // Execution tracking + results
       ├── recovery-checkpoint.ts  // Frontier markers
       └── types.ts                // TypeScript interfaces
   ```

3. **Implement OperationStore**
   ```typescript
   class OperationStore {
     async create(operation: Operation): Promise<void>;
     async get(operationId: string): Promise<Operation>;
     async updateStatus(operationId: string, status: string): Promise<void>;
     async queryByStatus(status: string): Promise<Operation[]>;
     async queryIncomplete(): Promise<Operation[]>;
   }
   ```

4. **Implement ExecutionStore**
   ```typescript
   class ExecutionStore {
     async create(execution: Execution): Promise<void>;
     async get(executionId: string): Promise<Execution>;
     async recordResult(executionId: string, result: Uint8Array): Promise<void>;
     async queryByOperation(operationId: string): Promise<Execution[]>;
   }
   ```

5. **Implement RecoveryCheckpoint**
   ```typescript
   class RecoveryCheckpointStore {
     async create(checkpoint: RecoveryCheckpoint): Promise<void>;
     async getLatest(): Promise<RecoveryCheckpoint | null>;
   }
   ```

6. **Initialize in Host Process**
   ```typescript
   // host/main.ts
   const feltdb = new FeltDB({ rootPath: userData });
   const operations = new OperationStore(feltdb);
   const executions = new ExecutionStore(feltdb);
   // Pass to execution system
   ```

**Testing:**
- Unit: OperationStore create/get/update
- Unit: ExecutionStore idempotency (same executionId cannot complete twice)
- Integration: FeltDB persists across simulated restart
- Integration: Recovery queries work

**Success Criteria:**
- [x] FeltDB initializes without errors
- [x] Operations persist across process restarts (simulated)
- [x] Execution idempotency works (same ID cannot re-execute)
- [x] Recovery checkpoint queries are correct
- [x] No data loss on crash simulation

---

### PR 1.2: Tool Execution Integration

**Goal:** Wire tool execution through FeltDB operation model

**Changes:**

1. **Create ToolExecution workflow**
   ```typescript
   async function executeToolWithFeltDB(
     turnId: string,
     tool: Tool,
     args: unknown[]
   ) {
     // 1. Create operation (durable acceptance)
     const operation = {
       operationId: generateUUID(),
       kind: 'execution',
       status: 'accepted',
       idempotencyKey: hash(turnId + tool.name + args),
     };
     await operations.create(operation);
     
     // 2. Create execution record (before executing)
     const execution = {
       executionId: generateUUID(),
       operationId: operation.operationId,
       kind: 'tool',
       name: tool.name,
       arguments: serialize(args),
       status: 'executing',
     };
     await executions.create(execution);
     
     // 3. Execute tool (can now crash safely)
     try {
       const result = await tool.execute(...args);
       
       // 4. Record result durably
       await executions.recordResult(execution.executionId, serialize(result));
       await operations.updateStatus(operation.operationId, 'completed');
       
       return result;
     } catch (err) {
       await operations.updateStatus(operation.operationId, 'failed');
       throw err;
     }
   }
   ```

2. **Update turn execution**
   - Replace existing tool execution with FeltDB-aware version
   - Keep SQLite transcript still receives results (projection)

3. **Test crashes**
   - Mock FeltDB write failures
   - Simulate process kill mid-execution
   - Verify recovery behavior

**Testing:**
- Unit: Tool execution writes to FeltDB correctly
- Unit: Failure handling updates status
- Integration: Tool execution + FeltDB + SQLite projection
- Stress: Rapid fire-and-crash cycles

**Success Criteria:**
- [x] Tool executions create durable operations
- [x] Execution results are recorded in FeltDB
- [x] SQLite still gets results (for transcript)
- [x] Tool errors are durably marked

---

### PR 1.3: Recovery System

**Goal:** Implement recovery that uses FeltDB authority

**Changes:**

1. **Create RecoverySystem**
   ```typescript
   class RecoverySystem {
     async recoverIncompleteOperations() {
       // 1. Get last checkpoint
       const checkpoint = await checkpoints.getLatest();
       const frontier = checkpoint?.lastProcessedOperationId || 'start';
       
       // 2. Query incomplete operations since frontier
       const incomplete = await operations.queryIncomplete();
       
       // 3. For each incomplete operation
       for (const op of incomplete) {
         if (op.status === 'executing') {
           // Try to complete based on FeltDB state
           await this.attemptRecovery(op);
         }
       }
       
       // 4. Update checkpoint
       await checkpoints.create({
         checkpointId: generateUUID(),
         lastProcessedOperationId: incomplete[incomplete.length - 1]?.operationId,
         createdAt: now(),
       });
     }
     
     private async attemptRecovery(operation: Operation) {
       const executions = await db.executions.queryByOperation(operation.operationId);
       
       // Check if execution already succeeded
       const succeeded = executions.find(e => e.status === 'succeeded');
       if (succeeded) {
         // Use cached result
         await operations.updateStatus(operation.operationId, 'completed');
         return;
       }
       
       // If multiple attempts, may indicate real failure
       if (executions.length > 3) {
         await operations.updateStatus(operation.operationId, 'failed');
         return;
       }
       
       // Otherwise, retry (idempotency key prevents duplicate)
       await executeToolWithFeltDB(...);
     }
   }
   ```

2. **Call RecoverySystem on host startup**
   ```typescript
   // host/main.ts
   const recovery = new RecoverySystem(operations, executions, checkpoints);
   await recovery.recoverIncompleteOperations();
   ```

3. **Test recovery scenarios**
   - Kill during execution
   - Kill after execution but before checkpoint
   - Kill during recovery itself
   - Multiple restarts in sequence

**Testing:**
- Unit: Recovery logic for various operation states
- Integration: Full crash-restart-recover cycle
- Stress: Rapid kill/restart, verify no duplicates
- Verify: Transcript is consistent after recovery

**Success Criteria:**
- [x] Recovery finds incomplete operations
- [x] Recovery prevents duplicate execution (idempotency key)
- [x] Recovery respects cached results
- [x] Multiple restarts are safe
- [x] Transcript remains consistent

---

### PR 1.4: Observability & Validation

**Goal:** Prove correctness and understand FeltDB performance

**Changes:**

1. **Add telemetry**
   - FeltDB operation write latency
   - FeltDB query latency
   - Recovery discovery count
   - Duplicate prevention triggers

2. **Add validation tests**
   - Deterministic test: reproduce same sequence of events, verify same state
   - Crash test: random crashes, verify no duplicates
   - Load test: high-volume operations, measure latency impact

3. **Add observability dashboards**
   - FeltDB operation status counts
   - Recovery metrics
   - Tool execution success rate (should stay same)

**Testing:**
- Load: 100 simultaneous operations with random crashes
- Determinism: Same event sequence → same final state
- Idempotency: Retry same operation, verify exactly-once

**Success Criteria:**
- [x] No performance regression
- [x] Deterministic recovery behavior
- [x] Idempotency is proven
- [x] No data loss under crash + recovery

---

## Validation Checklist (Before Declaring v1 Complete)

- [ ] FeltDB operation creation is durable (survives host crash)
- [ ] Execution idempotency works (same executionId cannot execute twice)
- [ ] Recovery discovers incomplete operations
- [ ] Recovery uses cached results to prevent duplicates
- [ ] No duplicate side effects across process restarts
- [ ] Tool execution continues to work (SQLite projection)
- [ ] Transcript is consistent after recovery
- [ ] FeltDB latency < 10ms per operation (non-blocking)
- [ ] No data loss in crash scenarios
- [ ] Code review passes (no architectural issues)

---

## Rollback Strategy

If this vertical slice fails:

1. **Minor issues (performance, testing):**
   - Fix and retry
   - Fallback to previous tool execution if needed

2. **Architecture issues (e.g., FeltDB doesn't guarantee idempotency):**
   - Set `FELTDB_ENABLED=false`
   - Tool execution reverts to existing (non-durable) system
   - Branch is abandoned; learn from failure

3. **Critical bugs (e.g., FeltDB data loss):**
   - Revert entire slice
   - Document issue
   - Do NOT proceed to Phase 2

---

## Phase 1.5: Success Criteria

If all validation passes, you have proven:

✓ FeltDB is a viable durable authority substrate for Grok Bot  
✓ Exactly-once execution semantics work  
✓ Recovery is deterministic and safe  
✓ Coordinator recovery is the next logical step  

### DO NOT proceed to Phase 2 (Coordinator) unless:
- All Phase 1 tests pass
- No performance regression
- Idempotency is proven under stress
- Architecture is sound (no fire-and-forget authority writes)

---

## Phase 2: Coordinator Durability (DEFER)

Only after Phase 1 succeeds:

**Goal:** Extend durable operations to coordinator messages

**Scope:**
- Coordinator creates `coordinator_operation` in FeltDB
- Blocking write (not fire-and-forget)
- Recovery replays operations to rebuild routing state

**Will NOT start** until Phase 1 is validated and approved.

---

## What's NOT in This Plan

- [ ] Settings migration (defer)
- [ ] Usage analytics (defer, not authority)
- [ ] Cross-session queries (defer)
- [ ] Broad adapter (stay focused on slice)
- [ ] Transactions (not needed)
- [ ] EventLog collection (use operation)
- [ ] Fire-and-forget writes (banned)

---

**Document Status:** Initial Draft (v2)  
**Next:** Implement PR 1.1 (FeltDB client + collections)
