import {
  ForgeSQLAPIError,
  errorCodes,
  sql as defaultSqlClient,
  type Result,
  type UpdateQueryResponse
} from "@forge/sql";
import {
  ConcurrentModificationError,
  ProvisioningNotReadyError,
  type StoredEcoWorkspace,
  type VerificationStore
} from "./ports";
import type { ForgeSqlClientLike, SqlPreparedStatementLike } from "./provisioning";

interface EcoWorkspaceSqlRow {
  readonly eco_issue_id: string;
  readonly revision_seq: number | string;
  readonly approval_generation: number | string;
  readonly updated_at_epoch_ms: number | string;
  readonly payload_json: string;
}

type PersistedPayload = Omit<StoredEcoWorkspace, "ecoIssueId" | "revisionSeq" | "updatedAtEpochMs">;

function parseBigIntNumber(val: number | string, fieldName: string): number {
  const num = typeof val === "number" ? val : Number(val);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Invalid integer column "${fieldName}": ${String(val)}`);
  }
  return num;
}

function isDuplicatePrimaryKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes("duplicate entry") ||
    msg.includes("primary") ||
    msg.includes("unique constraint") ||
    msg.includes("1062")
  );
}

/**
 * Issue #4: Verified Conditional Compare-and-Swap Store on `@forge/sql`.
 *
 * Architectural rationale verified against installed `@forge/kvs@2.1.2` and `@forge/sql@4.0.10`:
 * - Plain `@forge/kvs` `kvs.transact().set(key, value)` (in `out/transaction-api.js`) exposes NO
 *   conditional check; conditional writes in `@forge/kvs` exist only on Custom Entities via
 *   `EntityConditions`, which enforce a hard 240 KiB object limit (exceeded at 500 BOM edges = 242.3 KiB).
 * - `@forge/sql` executes parameterized single-statement SQL against per-installation TiDB with ACID
 *   row locking and returns `Result<UpdateQueryResponse>` containing `rows.affectedRows`.
 * - Conditional `UPDATE ... SET revision_seq = ? ... WHERE eco_issue_id = ? AND revision_seq = ?`
 *   atomically returns `affectedRows === 1` iff the caller held the latest `revision_seq`, and
 *   `affectedRows === 0` on any concurrent modification.
 */
export class ForgeSqlCasStore implements VerificationStore {
  private readonly sqlClient: ForgeSqlClientLike;

  constructor(sqlClient?: ForgeSqlClientLike) {
    this.sqlClient = sqlClient ?? (defaultSqlClient as unknown as ForgeSqlClientLike);
  }

  public async getEcoWorkspace(ecoIssueId: string): Promise<StoredEcoWorkspace | null> {
    let res: Result<EcoWorkspaceSqlRow>;
    try {
      res = await this.sqlClient
        .prepare<EcoWorkspaceSqlRow>(
          "SELECT eco_issue_id, revision_seq, approval_generation, updated_at_epoch_ms, payload_json FROM linelock_eco_workspaces WHERE eco_issue_id = ?"
        )
        .bindParams(ecoIssueId)
        .execute();
    } catch (err) {
      this.rethrowIfNotProvisioned(err);
      throw err;
    }

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    const payload = JSON.parse(row.payload_json) as PersistedPayload;
    const revisionSeq = parseBigIntNumber(row.revision_seq, "revision_seq");
    const updatedAtEpochMs = parseBigIntNumber(row.updated_at_epoch_ms, "updated_at_epoch_ms");

    return {
      ecoIssueId: row.eco_issue_id,
      revisionSeq,
      updatedAtEpochMs,
      ...payload
    };
  }

  public async insertInitialEcoWorkspace(
    workspace: Omit<StoredEcoWorkspace, "revisionSeq">
  ): Promise<StoredEcoWorkspace> {
    const payload: PersistedPayload = {
      catalog: workspace.catalog,
      eco: workspace.eco,
      proposedOperations: workspace.proposedOperations,
      attestations: workspace.attestations,
      pendingTransitionIntent: workspace.pendingTransitionIntent,
      finalizedReleaseReceipt: workspace.finalizedReleaseReceipt,
      unvalidatedDriftDetected: workspace.unvalidatedDriftDetected
    };

    try {
      const res = await this.sqlClient
        .prepare<UpdateQueryResponse>(
          "INSERT INTO linelock_eco_workspaces (eco_issue_id, revision_seq, approval_generation, updated_at_epoch_ms, payload_json) VALUES (?, ?, ?, ?, ?)"
        )
        .bindParams(
          workspace.ecoIssueId,
          1,
          workspace.eco.approvalGeneration,
          workspace.updatedAtEpochMs,
          JSON.stringify(payload)
        )
        .execute();

      if (res.rows.affectedRows !== 1) {
        throw new ConcurrentModificationError(
          `Initial workspace INSERT for ECO "${workspace.ecoIssueId}" affected ${res.rows.affectedRows} rows.`
        );
      }

      return {
        ...workspace,
        revisionSeq: 1
      };
    } catch (err) {
      if (err instanceof ConcurrentModificationError) {
        throw err;
      }
      this.rethrowIfNotProvisioned(err);
      if (isDuplicatePrimaryKeyError(err)) {
        throw new ConcurrentModificationError(
          `Workspace for ECO "${workspace.ecoIssueId}" was already initialized concurrently.`
        );
      }
      throw err;
    }
  }

  public async casUpdateEcoWorkspace(
    expectedRevisionSeq: number,
    nextWorkspace: Omit<StoredEcoWorkspace, "revisionSeq">
  ): Promise<StoredEcoWorkspace> {
    if (!Number.isSafeInteger(expectedRevisionSeq) || expectedRevisionSeq < 1) {
      throw new RangeError(`expectedRevisionSeq must be a positive safe integer, got ${expectedRevisionSeq}`);
    }

    const nextRevisionSeq = expectedRevisionSeq + 1;
    const payload: PersistedPayload = {
      catalog: nextWorkspace.catalog,
      eco: nextWorkspace.eco,
      proposedOperations: nextWorkspace.proposedOperations,
      attestations: nextWorkspace.attestations,
      pendingTransitionIntent: nextWorkspace.pendingTransitionIntent,
      finalizedReleaseReceipt: nextWorkspace.finalizedReleaseReceipt,
      unvalidatedDriftDetected: nextWorkspace.unvalidatedDriftDetected
    };

    let res: Result<UpdateQueryResponse>;
    try {
      res = await this.sqlClient
        .prepare<UpdateQueryResponse>(
          "UPDATE linelock_eco_workspaces SET revision_seq = ?, approval_generation = ?, updated_at_epoch_ms = ?, payload_json = ? WHERE eco_issue_id = ? AND revision_seq = ?"
        )
        .bindParams(
          nextRevisionSeq,
          nextWorkspace.eco.approvalGeneration,
          nextWorkspace.updatedAtEpochMs,
          JSON.stringify(payload),
          nextWorkspace.ecoIssueId,
          expectedRevisionSeq
        )
        .execute();
    } catch (err) {
      this.rethrowIfNotProvisioned(err);
      throw err;
    }

    if (res.rows.affectedRows === 0) {
      throw new ConcurrentModificationError(
        `CAS conflict on ECO "${nextWorkspace.ecoIssueId}": expected revision_seq=${expectedRevisionSeq}, affectedRows=0.`
      );
    }

    return {
      ...nextWorkspace,
      revisionSeq: nextRevisionSeq
    };
  }

  public async registerEvidenceIssueIds(issueIds: readonly string[]): Promise<void> {
    if (issueIds.length === 0) return;
    const registryKey = "__linelock_evidence_registry__";

    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await this.sqlClient
        .prepare<EcoWorkspaceSqlRow>(
          "SELECT eco_issue_id, revision_seq, approval_generation, updated_at_epoch_ms, payload_json FROM linelock_eco_workspaces WHERE eco_issue_id = ?"
        )
        .bindParams(registryKey)
        .execute();

      const existing = res.rows[0];
      if (!existing) {
        const merged = [...new Set(issueIds)].sort();
        try {
          const ins = await this.sqlClient
            .prepare<UpdateQueryResponse>(
              "INSERT INTO linelock_eco_workspaces (eco_issue_id, revision_seq, approval_generation, updated_at_epoch_ms, payload_json) VALUES (?, ?, ?, ?, ?)"
            )
            .bindParams(
              registryKey,
              1,
              1,
              Date.now(),
              JSON.stringify({ registeredEvidenceIssueIds: merged })
            )
            .execute();
          if (ins.rows.affectedRows === 1) return;
        } catch (err) {
          if (!isDuplicatePrimaryKeyError(err)) throw err;
        }
        continue;
      }

      const parsed = JSON.parse(existing.payload_json) as {
        readonly registeredEvidenceIssueIds?: readonly string[];
      };
      const merged = [
        ...new Set([...(parsed.registeredEvidenceIssueIds ?? []), ...issueIds])
      ].sort();
      const expectedRev = parseBigIntNumber(existing.revision_seq, "revision_seq");
      const upd = await this.sqlClient
        .prepare<UpdateQueryResponse>(
          "UPDATE linelock_eco_workspaces SET revision_seq = ?, approval_generation = ?, updated_at_epoch_ms = ?, payload_json = ? WHERE eco_issue_id = ? AND revision_seq = ?"
        )
        .bindParams(
          expectedRev + 1,
          expectedRev + 1,
          Date.now(),
          JSON.stringify({ registeredEvidenceIssueIds: merged }),
          registryKey,
          expectedRev
        )
        .execute();

      if (upd.rows.affectedRows === 1) return;
    }

    throw new ConcurrentModificationError(
      "Failed to register verification evidence issue IDs after 5 CAS attempts."
    );
  }

  public async isRegisteredEvidenceIssue(issueId: string): Promise<boolean> {
    const registryKey = "__linelock_evidence_registry__";
    const res = await this.sqlClient
      .prepare<EcoWorkspaceSqlRow>(
        "SELECT eco_issue_id, revision_seq, approval_generation, updated_at_epoch_ms, payload_json FROM linelock_eco_workspaces WHERE eco_issue_id = ?"
      )
      .bindParams(registryKey)
      .execute();

    const row = res.rows[0];
    if (!row) return false;
    const parsed = JSON.parse(row.payload_json) as {
      readonly registeredEvidenceIssueIds?: readonly string[];
    };
    return Boolean(parsed.registeredEvidenceIssueIds?.includes(issueId));
  }

  private rethrowIfNotProvisioned(err: unknown): void {
    if (err instanceof ForgeSQLAPIError && err.code === errorCodes.APP_NOT_ENABLED) {
      throw new ProvisioningNotReadyError(
        "PROVISIONING_IN_PROGRESS",
        "Forge SQL cluster is still provisioning (APP_NOT_ENABLED)."
      );
    }
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (
      msg.includes("linelock_eco_workspaces") &&
      (msg.includes("doesn't exist") || msg.includes("does not exist"))
    ) {
      throw new ProvisioningNotReadyError(
        "UNPROVISIONED",
        "Forge SQL table linelock_eco_workspaces has not yet been provisioned by schema migrations."
      );
    }
  }
}

/**
 * Contract-faithful TiDB / `@forge/sql` simulator for deterministic integration tests:
 * - Enforces single-statement SQL (rejects multi-statement `;` batches).
 * - Rejects DDL (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`) on the `/api/v1/execute` DML path
 *   with `ForgeSQLAPIError(INVALID_SQL_QUERY)`, matching real Forge SQL behavior.
 * - Supports `MigrationRunner` DDL & `__migrations` checkpointing on `/api/v1/execute/ddl`.
 * - Simulates `APP_NOT_ENABLED` during cold installation and injected DDL failures.
 * - Yields an async microtask tick before each query so `Promise.all` exercises real CAS races.
 */
export class SimulatedTiDbSqlClient implements ForgeSqlClientLike {
  public clusterEnabled: boolean;
  public failDdlMatchingSubstring: string | null = null;

  private readonly tablesCreated = new Set<string>();
  private nextMigrationId = 1;
  private readonly migrationsTable: { id: number; name: string; migratedAt: string }[] = [];
  private readonly ecoWorkspaces = new Map<string, EcoWorkspaceSqlRow>();
  private readonly provisioningAudit = new Map<
    string,
    { migration_run_id: string; trigger_source: string; completed_at_epoch_ms: number }
  >();

  constructor(options?: { readonly clusterEnabled?: boolean }) {
    this.clusterEnabled = options?.clusterEnabled ?? true;
  }

  public prepare<DataType = unknown>(query: string): SqlPreparedStatementLike<Result<DataType>> {
    let boundParams: unknown[] = [];
    const stmt: SqlPreparedStatementLike<Result<DataType>> = {
      bindParams: (...args: unknown[]) => {
        boundParams = args;
        return stmt;
      },
      execute: async () => this.executeDmlEndpoint<DataType>(query, boundParams)
    };
    return stmt;
  }

  public async executeRaw<DataType = unknown>(query: string): Promise<Result<DataType>> {
    return this.executeDmlEndpoint<DataType>(query, []);
  }

  public async executeDDL<DataType = unknown>(query: string): Promise<Result<DataType>> {
    await Promise.resolve();
    this.assertClusterEnabled();
    this.assertSingleStatement(query);

    if (this.failDdlMatchingSubstring && query.includes(this.failDdlMatchingSubstring)) {
      throw new ForgeSQLAPIError(
        { status: 500, statusText: "Internal Server Error", traceId: "sim-ddl-err" },
        {
          code: errorCodes.SQL_EXECUTION_ERROR,
          message: `Simulated TiDB DDL failure matching "${this.failDdlMatchingSubstring}"`
        }
      );
    }

    const normalized = query.trim().replace(/;$/, "").trim();

    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+__migrations\b/i.test(normalized)) {
      this.tablesCreated.add("__migrations");
      return { rows: makeUpdateResponse(0) } as unknown as Result<DataType>;
    }

    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+linelock_eco_workspaces\b/i.test(normalized)) {
      this.tablesCreated.add("linelock_eco_workspaces");
      return { rows: makeUpdateResponse(0) } as unknown as Result<DataType>;
    }

    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+linelock_provisioning_audit\b/i.test(normalized)) {
      this.tablesCreated.add("linelock_provisioning_audit");
      return { rows: makeUpdateResponse(0) } as unknown as Result<DataType>;
    }

    if (/^SELECT\s+id,\s*name,\s*migratedAt\s+FROM\s+__migrations$/i.test(normalized)) {
      this.assertTableExists("__migrations");
      return { rows: [...this.migrationsTable] } as unknown as Result<DataType>;
    }

    throw new ForgeSQLAPIError(
      { status: 400, statusText: "Bad Request", traceId: "sim-ddl-unsupported" },
      {
        code: errorCodes.INVALID_SQL_QUERY,
        message: `Unsupported DDL statement in simulator: ${normalized}`
      }
    );
  }

  private async executeDmlEndpoint<DataType>(
    query: string,
    params: readonly unknown[]
  ): Promise<Result<DataType>> {
    // Async boundary so concurrent callers interleave realistically
    await Promise.resolve();
    this.assertClusterEnabled();
    this.assertSingleStatement(query);

    const normalized = query.trim().replace(/;$/, "").trim();
    if (/^(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(normalized)) {
      throw new ForgeSQLAPIError(
        { status: 400, statusText: "Bad Request", traceId: "sim-dml-rejects-ddl" },
        {
          code: errorCodes.INVALID_SQL_QUERY,
          message:
            "DDL statements are disallowed on /api/v1/execute; use MigrationRunner (/api/v1/execute/ddl)."
        }
      );
    }

    if (/^INSERT\s+INTO\s+__migrations\s*\(\s*name\s*\)\s*VALUES\s*\(\s*\?\s*\)$/i.test(normalized)) {
      this.assertTableExists("__migrations");
      const name = String(params[0]);
      const id = this.nextMigrationId++;
      this.migrationsTable.push({ id, name, migratedAt: new Date().toISOString() });
      return { rows: makeUpdateResponse(1, id) } as unknown as Result<DataType>;
    }

    if (/^INSERT\s+INTO\s+linelock_provisioning_audit\b/i.test(normalized)) {
      this.assertTableExists("linelock_provisioning_audit");
      const runId = String(params[0]);
      const source = String(params[1]);
      const completedAt = Number(params[2]);
      if (this.provisioningAudit.has(runId)) {
        throw duplicateKeySqlError(runId, "PRIMARY");
      }
      this.provisioningAudit.set(runId, {
        migration_run_id: runId,
        trigger_source: source,
        completed_at_epoch_ms: completedAt
      });
      return { rows: makeUpdateResponse(1) } as unknown as Result<DataType>;
    }

    if (/^SELECT\s+eco_issue_id,\s*revision_seq,\s*approval_generation,\s*updated_at_epoch_ms,\s*payload_json\s+FROM\s+linelock_eco_workspaces\s+WHERE\s+eco_issue_id\s*=\s*\?$/i.test(normalized)) {
      this.assertTableExists("linelock_eco_workspaces");
      const ecoId = String(params[0]);
      const row = this.ecoWorkspaces.get(ecoId);
      return { rows: row ? [{ ...row }] : [] } as unknown as Result<DataType>;
    }

    if (/^INSERT\s+INTO\s+linelock_eco_workspaces\b/i.test(normalized)) {
      this.assertTableExists("linelock_eco_workspaces");
      const ecoId = String(params[0]);
      if (this.ecoWorkspaces.has(ecoId)) {
        throw duplicateKeySqlError(ecoId, "PRIMARY");
      }
      this.ecoWorkspaces.set(ecoId, {
        eco_issue_id: ecoId,
        revision_seq: Number(params[1]),
        approval_generation: Number(params[2]),
        updated_at_epoch_ms: Number(params[3]),
        payload_json: String(params[4])
      });
      return { rows: makeUpdateResponse(1) } as unknown as Result<DataType>;
    }

    if (
      /^UPDATE\s+linelock_eco_workspaces\s+SET\s+revision_seq\s*=\s*\?,\s*approval_generation\s*=\s*\?,\s*updated_at_epoch_ms\s*=\s*\?,\s*payload_json\s*=\s*\?\s+WHERE\s+eco_issue_id\s*=\s*\?\s+AND\s+revision_seq\s*=\s*\?$/i.test(
        normalized
      )
    ) {
      this.assertTableExists("linelock_eco_workspaces");
      const nextRev = Number(params[0]);
      const nextGen = Number(params[1]);
      const updatedAt = Number(params[2]);
      const payloadJson = String(params[3]);
      const ecoId = String(params[4]);
      const expectedRev = Number(params[5]);

      const existing = this.ecoWorkspaces.get(ecoId);
      if (!existing || Number(existing.revision_seq) !== expectedRev) {
        return { rows: makeUpdateResponse(0) } as unknown as Result<DataType>;
      }

      this.ecoWorkspaces.set(ecoId, {
        eco_issue_id: ecoId,
        revision_seq: nextRev,
        approval_generation: nextGen,
        updated_at_epoch_ms: updatedAt,
        payload_json: payloadJson
      });
      return { rows: makeUpdateResponse(1) } as unknown as Result<DataType>;
    }

    throw new ForgeSQLAPIError(
      { status: 400, statusText: "Bad Request", traceId: "sim-dml-unsupported" },
      {
        code: errorCodes.INVALID_SQL_QUERY,
        message: `Unsupported DML statement in simulator: ${normalized}`
      }
    );
  }

  private assertClusterEnabled(): void {
    if (!this.clusterEnabled) {
      throw new ForgeSQLAPIError(
        { status: 424, statusText: "Failed Dependency", traceId: "sim-not-enabled" },
        {
          code: errorCodes.APP_NOT_ENABLED,
          message: "Forge SQL database is not yet provisioned for this installation."
        }
      );
    }
  }

  private assertSingleStatement(query: string): void {
    const stripped = query.trim().replace(/;$/, "");
    if (stripped.includes(";")) {
      throw new ForgeSQLAPIError(
        { status: 400, statusText: "Bad Request", traceId: "sim-multi-stmt" },
        {
          code: errorCodes.INVALID_SQL_QUERY,
          message: "Multi-statement SQL queries are rejected by Forge SQL."
        }
      );
    }
  }

  private assertTableExists(tableName: string): void {
    if (!this.tablesCreated.has(tableName)) {
      throw new ForgeSQLAPIError(
        { status: 400, statusText: "Bad Request", traceId: "sim-missing-table" },
        {
          code: errorCodes.SQL_EXECUTION_ERROR,
          message: `Table '${tableName}' doesn't exist`
        }
      );
    }
  }
}

function makeUpdateResponse(affectedRows: number, insertId = 0): UpdateQueryResponse {
  return {
    affectedRows,
    fieldCount: 0,
    info: "",
    insertId,
    serverStatus: 2,
    warningStatus: 0
  };
}

function duplicateKeySqlError(entry: string, keyName: string): ForgeSQLAPIError {
  return new ForgeSQLAPIError(
    { status: 409, statusText: "Conflict", traceId: "sim-dup-pk" },
    {
      code: errorCodes.SQL_EXECUTION_ERROR,
      message: `Error 1062 (23000): Duplicate entry '${entry}' for key '${keyName}'`
    }
  );
}
