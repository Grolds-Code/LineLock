import {
  ForgeSQLAPIError,
  errorCodes,
  migrationRunner as defaultMigrationRunner,
  sql as defaultSqlClient,
  type Result,
  type UpdateQueryResponse
} from "@forge/sql";
import type { ProvisioningState, ProvisioningStatusReport } from "./ports.js";

export interface SqlPreparedStatementLike<TResponse> {
  bindParams(...args: unknown[]): SqlPreparedStatementLike<TResponse>;
  execute(): Promise<TResponse>;
}

export interface ForgeSqlClientLike {
  prepare<DataType = unknown>(query: string): SqlPreparedStatementLike<Result<DataType>>;
  executeDDL<DataType = unknown>(query: string): Promise<Result<DataType>>;
  executeRaw<DataType = unknown>(query: string): Promise<Result<DataType>>;
}

export interface MigrationVersionRecord {
  readonly id: number;
  readonly name: string;
  readonly migratedAt: Date;
}

export interface MigrationRunnerLike {
  enqueue(name: string, statement: string): MigrationRunnerLike;
  getEnqueued(): { name: string; statement: string }[];
  list(): Promise<MigrationVersionRecord[]>;
  run(): Promise<string[]>;
}

export const LINELOCK_SQL_MIGRATIONS: readonly {
  readonly name: string;
  readonly statement: string;
}[] = [
  {
    name: "v001_create_linelock_eco_workspaces",
    statement: `CREATE TABLE IF NOT EXISTS linelock_eco_workspaces (
      eco_issue_id VARCHAR(64) PRIMARY KEY,
      revision_seq BIGINT NOT NULL,
      approval_generation BIGINT NOT NULL,
      updated_at_epoch_ms BIGINT NOT NULL,
      payload_json LONGTEXT NOT NULL
    );`
  },
  {
    name: "v002_create_linelock_provisioning_audit",
    statement: `CREATE TABLE IF NOT EXISTS linelock_provisioning_audit (
      migration_run_id VARCHAR(96) PRIMARY KEY,
      trigger_source VARCHAR(64) NOT NULL,
      completed_at_epoch_ms BIGINT NOT NULL
    );`
  }
];

function extractSqlErrorCode(err: unknown): string {
  if (err instanceof ForgeSQLAPIError) {
    return err.code;
  }
  if (
    err instanceof Error &&
    "cause" in err &&
    err.cause instanceof ForgeSQLAPIError
  ) {
    return err.cause.code;
  }
  if (err instanceof Error) {
    return err.name || errorCodes.UNKNOWN_ERROR;
  }
  return errorCodes.UNKNOWN_ERROR;
}

function isMissingTableError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${"cause" in err && err.cause instanceof Error ? err.cause.message : ""}`
      : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("doesn't exist") ||
    lower.includes("does not exist") ||
    lower.includes("no such table") ||
    lower.includes("__migrations")
  );
}

/**
 * Issue #7: Explicit Forge SQL asynchronous provisioning & schema migration manager.
 *
 * Uses @forge/sql's DDL migration endpoint (`/api/v1/execute/ddl` via `MigrationRunner`),
 * never `executeRaw` (`/api/v1/execute` rejects DDL). Handles asynchronous TiDB cluster
 * creation (`APP_NOT_ENABLED`), partial migration failures (`PROVISIONING_FAILED`), and
 * idempotent recovery without making unsupported cold-start latency promises.
 */
export class SqlProvisioningManager {
  private readonly sqlClient: ForgeSqlClientLike;
  private readonly runner: MigrationRunnerLike;
  private readonly now: () => number;

  private lastState: ProvisioningState = "UNPROVISIONED";
  private lastAttemptAtEpochMs: number | null = null;
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;
  private inFlightPromise: Promise<ProvisioningStatusReport> | null = null;

  constructor(options?: {
    readonly sqlClient?: ForgeSqlClientLike;
    readonly migrationRunner?: MigrationRunnerLike;
    readonly now?: () => number;
  }) {
    this.sqlClient = options?.sqlClient ?? (defaultSqlClient as unknown as ForgeSqlClientLike);
    this.runner =
      options?.migrationRunner ?? (defaultMigrationRunner as unknown as MigrationRunnerLike);
    this.now = options?.now ?? (() => Date.now());

    for (const m of LINELOCK_SQL_MIGRATIONS) {
      this.runner.enqueue(m.name, m.statement);
    }
  }

  public async inspectStatus(): Promise<ProvisioningStatusReport> {
    const requiredNames = LINELOCK_SQL_MIGRATIONS.map((m) => m.name);

    try {
      const applied = await this.runner.list();
      const appliedSet = new Set(applied.map((a) => a.name));
      const appliedMigrations = requiredNames.filter((n) => appliedSet.has(n));
      const pendingMigrations = requiredNames.filter((n) => !appliedSet.has(n));

      if (pendingMigrations.length === 0) {
        this.lastState = "READY";
        this.lastErrorCode = null;
        this.lastErrorMessage = null;
      } else if (this.lastState === "READY") {
        this.lastState = "UNPROVISIONED";
      }

      return {
        state: this.lastState,
        appliedMigrations,
        pendingMigrations,
        lastAttemptAtEpochMs: this.lastAttemptAtEpochMs,
        lastErrorCode: this.lastErrorCode,
        lastErrorMessage: this.lastErrorMessage
      };
    } catch (err) {
      const code = extractSqlErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);

      if (code === errorCodes.APP_NOT_ENABLED) {
        this.lastState = "PROVISIONING_IN_PROGRESS";
        this.lastErrorCode = code;
        this.lastErrorMessage =
          "Forge SQL cluster is still provisioning asynchronously on the Atlassian host (APP_NOT_ENABLED).";
        return {
          state: "PROVISIONING_IN_PROGRESS",
          appliedMigrations: [],
          pendingMigrations: requiredNames,
          lastAttemptAtEpochMs: this.lastAttemptAtEpochMs,
          lastErrorCode: this.lastErrorCode,
          lastErrorMessage: this.lastErrorMessage
        };
      }

      if (isMissingTableError(err) && this.lastState !== "PROVISIONING_FAILED") {
        return {
          state: "UNPROVISIONED",
          appliedMigrations: [],
          pendingMigrations: requiredNames,
          lastAttemptAtEpochMs: this.lastAttemptAtEpochMs,
          lastErrorCode: null,
          lastErrorMessage: null
        };
      }

      if (this.lastState !== "PROVISIONING_FAILED") {
        this.lastState = "PROVISIONING_FAILED";
        this.lastErrorCode = code;
        this.lastErrorMessage = message;
      }

      return {
        state: this.lastState,
        appliedMigrations: [],
        pendingMigrations: requiredNames,
        lastAttemptAtEpochMs: this.lastAttemptAtEpochMs,
        lastErrorCode: this.lastErrorCode,
        lastErrorMessage: this.lastErrorMessage
      };
    }
  }

  public async runMigrations(triggerSource: string): Promise<ProvisioningStatusReport> {
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = this.executeMigrationsInternal(triggerSource).finally(() => {
      this.inFlightPromise = null;
    });

    return this.inFlightPromise;
  }

  private async executeMigrationsInternal(
    triggerSource: string
  ): Promise<ProvisioningStatusReport> {
    const attemptEpoch = this.now();
    this.lastAttemptAtEpochMs = attemptEpoch;
    this.lastState = "PROVISIONING_IN_PROGRESS";

    for (const m of LINELOCK_SQL_MIGRATIONS) {
      this.runner.enqueue(m.name, m.statement);
    }

    try {
      await this.runner.run();

      const runId = `${triggerSource}:${attemptEpoch}`;
      await this.sqlClient
        .prepare<UpdateQueryResponse>(
          "INSERT INTO linelock_provisioning_audit (migration_run_id, trigger_source, completed_at_epoch_ms) VALUES (?, ?, ?)"
        )
        .bindParams(runId, triggerSource, attemptEpoch)
        .execute();

      this.lastState = "READY";
      this.lastErrorCode = null;
      this.lastErrorMessage = null;

      return this.inspectStatus();
    } catch (err) {
      const code = extractSqlErrorCode(err);
      const message =
        err instanceof Error
          ? `${err.message}${"cause" in err && err.cause instanceof Error ? ` [cause: ${err.cause.message}]` : ""}`
          : String(err);

      if (code === errorCodes.APP_NOT_ENABLED) {
        this.lastState = "PROVISIONING_IN_PROGRESS";
        this.lastErrorCode = errorCodes.APP_NOT_ENABLED;
        this.lastErrorMessage =
          "Forge SQL backend returned APP_NOT_ENABLED; cluster provisioning has not yet completed.";
      } else {
        this.lastState = "PROVISIONING_FAILED";
        this.lastErrorCode = code;
        this.lastErrorMessage = message;
      }

      // Inspect partially applied migrations if __migrations already exists
      let appliedNames: string[] = [];
      try {
        const applied = await this.runner.list();
        appliedNames = applied.map((a) => a.name);
      } catch {
        appliedNames = [];
      }

      const appliedSet = new Set(appliedNames);
      const requiredNames = LINELOCK_SQL_MIGRATIONS.map((m) => m.name);

      return {
        state: this.lastState,
        appliedMigrations: requiredNames.filter((n) => appliedSet.has(n)),
        pendingMigrations: requiredNames.filter((n) => !appliedSet.has(n)),
        lastAttemptAtEpochMs: this.lastAttemptAtEpochMs,
        lastErrorCode: this.lastErrorCode,
        lastErrorMessage: this.lastErrorMessage
      };
    }
  }
}
