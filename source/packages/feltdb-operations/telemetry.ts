/**
 * Telemetry: Measure FeltDB performance and correctness.
 * Used for observability and validation of authority substrate.
 */

export interface OperationMetrics {
  operationsCreated: number;
  operationCreationTimeMs: number[];
  operationStatusUpdates: number;
  statusUpdateTimeMs: number[];
}

export interface ExecutionMetrics {
  executionsCreated: number;
  executionCreationTimeMs: number[];
  resultRecordings: number;
  resultRecordingTimeMs: number[];
  errorRecordings: number;
}

export interface RecoveryMetrics {
  recoveryRunsCompleted: number;
  totalRecoveryTimeMs: number[];
  operationsRecovered: number;
  operationsFailed: number;
  checkpointsCreated: number;
}

export interface QueryMetrics {
  queriesByStatus: number;
  queryTimeMs: number[];
  queryResults: number;
}

export interface DurabilityMetrics {
  idempotencyKeyDuplicates: number;
  versionConflicts: number;
  crashSimulations: number;
  dataLossEvents: number;
}

export class Telemetry {
  private operations: OperationMetrics = {
    operationsCreated: 0,
    operationCreationTimeMs: [],
    operationStatusUpdates: 0,
    statusUpdateTimeMs: [],
  };

  private executions: ExecutionMetrics = {
    executionsCreated: 0,
    executionCreationTimeMs: [],
    resultRecordings: 0,
    resultRecordingTimeMs: [],
    errorRecordings: 0,
  };

  private recovery: RecoveryMetrics = {
    recoveryRunsCompleted: 0,
    totalRecoveryTimeMs: [],
    operationsRecovered: 0,
    operationsFailed: 0,
    checkpointsCreated: 0,
  };

  private queries: QueryMetrics = {
    queriesByStatus: 0,
    queryTimeMs: [],
    queryResults: 0,
  };

  private durability: DurabilityMetrics = {
    idempotencyKeyDuplicates: 0,
    versionConflicts: 0,
    crashSimulations: 0,
    dataLossEvents: 0,
  };

  recordOperationCreation(timeMs: number): void {
    this.operations.operationsCreated++;
    this.operations.operationCreationTimeMs.push(timeMs);
  }

  recordOperationStatusUpdate(timeMs: number): void {
    this.operations.operationStatusUpdates++;
    this.operations.statusUpdateTimeMs.push(timeMs);
  }

  recordExecutionCreation(timeMs: number): void {
    this.executions.executionsCreated++;
    this.executions.executionCreationTimeMs.push(timeMs);
  }

  recordResultRecording(timeMs: number): void {
    this.executions.resultRecordings++;
    this.executions.resultRecordingTimeMs.push(timeMs);
  }

  recordErrorRecording(): void {
    this.executions.errorRecordings++;
  }

  recordRecoveryRun(timeMs: number, recovered: number, failed: number): void {
    this.recovery.recoveryRunsCompleted++;
    this.recovery.totalRecoveryTimeMs.push(timeMs);
    this.recovery.operationsRecovered += recovered;
    this.recovery.operationsFailed += failed;
  }

  recordCheckpointCreation(): void {
    this.recovery.checkpointsCreated++;
  }

  recordQuery(timeMs: number, resultCount: number): void {
    this.queries.queriesByStatus++;
    this.queries.queryTimeMs.push(timeMs);
    this.queries.queryResults += resultCount;
  }

  recordIdempotencyKeyDuplicate(): void {
    this.durability.idempotencyKeyDuplicates++;
  }

  recordVersionConflict(): void {
    this.durability.versionConflicts++;
  }

  recordCrashSimulation(): void {
    this.durability.crashSimulations++;
  }

  recordDataLoss(): void {
    this.durability.dataLossEvents++;
  }

  /**
   * Get statistics on operations metrics.
   */
  getOperationStats() {
    return {
      created: this.operations.operationsCreated,
      avgCreationTimeMs: this.average(this.operations.operationCreationTimeMs),
      maxCreationTimeMs: this.max(this.operations.operationCreationTimeMs),
      statusUpdates: this.operations.operationStatusUpdates,
      avgUpdateTimeMs: this.average(this.operations.statusUpdateTimeMs),
      maxUpdateTimeMs: this.max(this.operations.statusUpdateTimeMs),
    };
  }

  /**
   * Get statistics on execution metrics.
   */
  getExecutionStats() {
    return {
      created: this.executions.executionsCreated,
      avgCreationTimeMs: this.average(this.executions.executionCreationTimeMs),
      maxCreationTimeMs: this.max(this.executions.executionCreationTimeMs),
      resultRecordings: this.executions.resultRecordings,
      avgResultRecordingTimeMs: this.average(this.executions.resultRecordingTimeMs),
      maxResultRecordingTimeMs: this.max(this.executions.resultRecordingTimeMs),
      errorRecordings: this.executions.errorRecordings,
    };
  }

  /**
   * Get statistics on recovery metrics.
   */
  getRecoveryStats() {
    return {
      runsCompleted: this.recovery.recoveryRunsCompleted,
      avgRecoveryTimeMs: this.average(this.recovery.totalRecoveryTimeMs),
      maxRecoveryTimeMs: this.max(this.recovery.totalRecoveryTimeMs),
      operationsRecovered: this.recovery.operationsRecovered,
      operationsFailed: this.recovery.operationsFailed,
      checkpointsCreated: this.recovery.checkpointsCreated,
    };
  }

  /**
   * Get statistics on query metrics.
   */
  getQueryStats() {
    return {
      totalQueries: this.queries.queriesByStatus,
      avgQueryTimeMs: this.average(this.queries.queryTimeMs),
      maxQueryTimeMs: this.max(this.queries.queryTimeMs),
      totalResultsReturned: this.queries.queryResults,
      avgResultsPerQuery: this.queries.queriesByStatus > 0 ? this.queries.queryResults / this.queries.queriesByStatus : 0,
    };
  }

  /**
   * Get durability metrics.
   */
  getDurabilityStats() {
    return {
      idempotencyKeyDuplicates: this.durability.idempotencyKeyDuplicates,
      versionConflicts: this.durability.versionConflicts,
      crashSimulations: this.durability.crashSimulations,
      dataLossEvents: this.durability.dataLossEvents,
      dataLossRate: this.durability.crashSimulations > 0
        ? (this.durability.dataLossEvents / this.durability.crashSimulations * 100).toFixed(2) + '%'
        : 'N/A',
    };
  }

  /**
   * Get all metrics.
   */
  getAllStats() {
    return {
      operations: this.getOperationStats(),
      executions: this.getExecutionStats(),
      recovery: this.getRecoveryStats(),
      queries: this.getQueryStats(),
      durability: this.getDurabilityStats(),
    };
  }

  /**
   * Print human-readable telemetry report.
   */
  printReport(): void {
    const stats = this.getAllStats();
    console.log('\n=== FeltDB Authority Substrate - Telemetry Report ===\n');

    console.log('Operations:');
    console.log(`  Created: ${stats.operations.created}`);
    console.log(`  Avg creation time: ${stats.operations.avgCreationTimeMs.toFixed(2)}ms`);
    console.log(`  Max creation time: ${stats.operations.maxCreationTimeMs}ms`);
    console.log(`  Status updates: ${stats.operations.statusUpdates}`);
    console.log(`  Avg update time: ${stats.operations.avgUpdateTimeMs.toFixed(2)}ms\n`);

    console.log('Executions:');
    console.log(`  Created: ${stats.executions.created}`);
    console.log(`  Avg creation time: ${stats.executions.avgCreationTimeMs.toFixed(2)}ms`);
    console.log(`  Result recordings: ${stats.executions.resultRecordings}`);
    console.log(`  Avg result time: ${stats.executions.avgResultRecordingTimeMs.toFixed(2)}ms`);
    console.log(`  Error recordings: ${stats.executions.errorRecordings}\n`);

    console.log('Recovery:');
    console.log(`  Runs completed: ${stats.recovery.runsCompleted}`);
    console.log(`  Avg recovery time: ${stats.recovery.avgRecoveryTimeMs.toFixed(2)}ms`);
    console.log(`  Operations recovered: ${stats.recovery.operationsRecovered}`);
    console.log(`  Operations failed: ${stats.recovery.operationsFailed}`);
    console.log(`  Checkpoints created: ${stats.recovery.checkpointsCreated}\n`);

    console.log('Queries:');
    console.log(`  Total queries: ${stats.queries.totalQueries}`);
    console.log(`  Avg query time: ${stats.queries.avgQueryTimeMs.toFixed(2)}ms`);
    console.log(`  Avg results per query: ${stats.queries.avgResultsPerQuery.toFixed(1)}\n`);

    console.log('Durability:');
    console.log(`  Idempotency key duplicates: ${stats.durability.idempotencyKeyDuplicates}`);
    console.log(`  Version conflicts: ${stats.durability.versionConflicts}`);
    console.log(`  Crash simulations: ${stats.durability.crashSimulations}`);
    console.log(`  Data loss events: ${stats.durability.dataLossEvents}`);
    console.log(`  Data loss rate: ${stats.durability.dataLossRate}\n`);
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private max(values: number[]): number {
    if (values.length === 0) return 0;
    return Math.max(...values);
  }
}

// Global singleton
export const telemetry = new Telemetry();
