import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { LiveJiraIssueProjection } from "../src/core/index";
import {
  ForgeSqlCasStore,
  LineLockService,
  SimulatedTiDbSqlClient,
  SqlProvisioningManager,
  type ConnectivityProbeResult,
  type CreateEvidenceSlotCallbacks,
  type EvidenceSlotStage,
  type JiraPlatformGateway,
  type MigrationRunnerLike,
  type ProvisionedVerificationIssue,
  type VerificationIssueSeedSpec
} from "../src/forge/index";
import type { IndustryTemplateId } from "../src/scenarios/templateMetadata";
import {
  HELIOS_BASE_EPOCH_MS,
  createHeliosTrustedRoles
} from "../src/scenarios/heliosBatteryPack";

const require = createRequire(import.meta.url);
const { MigrationRunner: SdkMigrationRunner } = require("@forge/sql/out/migration.js") as {
  MigrationRunner: new (client: unknown) => MigrationRunnerLike;
};

type IssueWithProject = LiveJiraIssueProjection & { readonly projectKey: string };

class RecoveryGateway implements JiraPlatformGateway {
  readonly issues = new Map<string, IssueWithProject>();
  readonly provenance = new Map<string, string>();
  createCount = 0;
  crashMode: "afterCheckpointOnce" | "beforeCheckpointOnce" | null = null;

  constructor() {
    this.issues.set("66400", {
      issueId: "66400", issueKey: "ECO-1", projectKey: "ECO",
      issueTypeId: "10200",
      projectId: "10010",
      issueTypeName: "Engineering Change Order",
      summary: "Qualification-gated capacitor engineering change",
      description: "Controlled ECO", statusCategoryKey: "new",
      resolutionName: null, updatedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      structuredFields: {}
    });
  }

  async fetchLiveIssue(id: string): Promise<LiveJiraIssueProjection> {
    const issue = await this.fetchLiveIssueByKeyOrId(id);
    const { projectKey: _projectKey, ...projection } = issue;
    return projection;
  }

  async fetchLiveIssueByKeyOrId(keyOrId: string): Promise<IssueWithProject> {
    const issue = this.issues.get(keyOrId) ??
      [...this.issues.values()].find((item) => item.issueKey === keyOrId);
    if (!issue) throw new Error(`Jira issue not found: ${keyOrId}`);
    return issue;
  }

  async fetchProjectRoleMembers(
    _projectKey: string,
    requiredRoles: readonly string[]
  ): Promise<Record<string, readonly string[]>> {
    const roles = createHeliosTrustedRoles();
    return Object.fromEntries(requiredRoles.map((role) => [role, roles[role] ?? []]));
  }

  async verifyProvisioningIssueProvenance(params: {
    readonly issueKeyOrId: string;
    readonly ecoIssueId: string;
    readonly ecoIssueKey: string;
    readonly projectKey: string;
    readonly templateId: IndustryTemplateId;
    readonly evidenceId: string;
    readonly operationId: string;
  }): Promise<{ readonly jiraIssueId: string; readonly jiraIssueKey: string }> {
    const issue = await this.fetchLiveIssueByKeyOrId(params.issueKeyOrId);
    if (issue.projectKey !== params.projectKey ||
        this.provenance.get(issue.issueId) !== params.operationId) {
      throw new Error("Failed immutable Jira provisioning provenance.");
    }
    return { jiraIssueId: issue.issueId, jiraIssueKey: issue.issueKey };
  }

  async provisionVerificationIssues(): Promise<readonly ProvisionedVerificationIssue[]> {
    throw new Error("The production slot gateway must not use legacy six-ticket bulk creation.");
  }

  async provisionVerificationIssueSlot(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly ecoIssueId: string;
    readonly templateId: IndustryTemplateId;
    readonly spec: VerificationIssueSeedSpec;
    readonly operationId: string;
    readonly stage?: EvidenceSlotStage;
    readonly existingIssueId?: string;
    readonly existingIssueKey?: string;
    readonly callbacks: CreateEvidenceSlotCallbacks;
  }): Promise<ProvisionedVerificationIssue> {
    let id = params.existingIssueId ?? "";
    if (id) {
      if (this.provenance.get(id) !== params.operationId) {
        throw new Error("Attempted resume with incorrect Jira provenance.");
      }
    } else {
      id = String(88000 + this.createCount);
      const key = `ECO-${100 + this.createCount}`;
      this.createCount++;
      this.provenance.set(id, params.operationId);
      this.issues.set(id, {
        issueId: id, issueKey: key, projectKey: params.projectKey,
        issueTypeId: "10000", issueTypeName: "Task", summary: params.spec.summary,
        description: params.spec.description, statusCategoryKey: "new",
        resolutionName: null, updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + this.createCount,
        structuredFields: {}
      });
      if (this.crashMode === "beforeCheckpointOnce") {
        this.crashMode = null;
        throw new Error("Simulated lost response after successful Jira issue creation.");
      }
      await params.callbacks.onCreated(id, key);
      if (this.crashMode === "afterCheckpointOnce") {
        this.crashMode = null;
        throw new Error("Simulated crash after durable Jira identity checkpoint.");
      }
    }
    const current = this.issues.get(id)!;
    this.issues.set(id, {
      ...current, statusCategoryKey: "done", resolutionName: "Done"
    });
    await params.callbacks.onDone();
    await params.callbacks.onLinked();
    const complete = await this.fetchLiveIssue(id);
    return { evidenceId: params.spec.evidenceId, liveIssue: complete };
  }

  async probeConnectivity(): Promise<ConnectivityProbeResult> {
    return {
      ok: true, checkedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      callerAccountId: "acct-admin", callerDisplayName: "Test Admin",
      jiraServerBaseUrl: "https://test.atlassian.net", jiraDeploymentType: "Cloud",
      issueReachable: true, resolvedRoleCount: 2, diagnostics: []
    };
  }
}

async function makeRig() {
  let clock = HELIOS_BASE_EPOCH_MS + 100000;
  const sql = new SimulatedTiDbSqlClient({ clusterEnabled: true });
  const store = new ForgeSqlCasStore(sql);
  const provisioning = new SqlProvisioningManager({
    sqlClient: sql, migrationRunner: new SdkMigrationRunner(sql), now: () => ++clock
  });
  await provisioning.runMigrations("install");
  const jira = new RecoveryGateway();
  const service = new LineLockService({
    store, jira, provisioning, now: () => ++clock
  });
  const request = {
    projectKey: "ECO", ecoIssueId: "66400", ecoIssueKey: "ECO-1",
    callerAccountId: "acct-admin"
  } as const;
  return { store, jira, service, request };
}

describe("Durable Jira evidence provisioning, live-issue identity and crash recovery", () => {
  it("creates six exact qualification tickets and makes double-click retry idempotent", async () => {
    const { store, jira, service, request } = await makeRig();
    const initial = await service.provisionLiveJiraWorkspace(request);
    expect(initial.evidenceIntegrity).toHaveLength(6);
    expect(initial.evidenceIntegrity?.every((row) => row.hashMatches && row.statusIsDone)).toBe(true);
    expect(jira.createCount).toBe(6);
    const ledger = await store.getProvisioningLedger("66400");
    expect(ledger?.status).toBe("COMPLETE");
    expect(Object.values(ledger!.slots).every((slot) => slot.stage === "LINKED")).toBe(true);
    expect(await store.listEcoWorkspaces()).toHaveLength(1);
    const second = await service.provisionLiveJiraWorkspace(request);
    expect(second.workspace?.revisionSeq).toBe(initial.workspace?.revisionSeq);
    expect(jira.createCount).toBe(6);
  });

  it("resumes an interrupted slot from its durable Jira identity without duplicating it", async () => {
    const { store, jira, service, request } = await makeRig();
    jira.crashMode = "afterCheckpointOnce";
    await expect(service.provisionLiveJiraWorkspace(request)).rejects.toThrow(/Simulated crash/);
    const failed = await store.getProvisioningLedger("66400");
    expect(failed?.status).toBe("FAILED");
    expect(Object.values(failed!.slots)[0]?.stage).toBe("CREATED");
    const completed = await service.provisionLiveJiraWorkspace(request);
    expect(completed.evidenceIntegrity).toHaveLength(6);
    expect(jira.createCount).toBe(6);
    expect((await store.getProvisioningLedger("66400"))?.status).toBe("COMPLETE");
  });

  it("never re-creates a Jira ticket after an uncertain create response", async () => {
    const { store, jira, service, request } = await makeRig();
    jira.crashMode = "beforeCheckpointOnce";
    await expect(service.provisionLiveJiraWorkspace(request)).rejects.toThrow(/lost response/);
    const uncertain = await store.getProvisioningLedger("66400");
    expect(Object.values(uncertain!.slots)[0]?.stage).toBe("CREATING");
    await expect(service.provisionLiveJiraWorkspace(request)).rejects.toThrow(
      /do not run another create request/
    );
    expect(jira.createCount).toBe(1);
  });

  it("recovers an ambiguous Jira-created issue only after verifying the original operation identity", async () => {
    const { store, jira, service, request } = await makeRig();
    jira.crashMode = "beforeCheckpointOnce";
    await expect(service.provisionLiveJiraWorkspace(request)).rejects.toThrow(/lost response/);
    const unresolved = await store.getProvisioningLedger("66400");
    const slot = Object.values(unresolved!.slots)[0]!;
    await expect(service.reconcileUncertainProvisioningSlot({
      ecoIssueId: "66400", projectKey: "ECO",
      evidenceId: slot.evidenceId, issueKeyOrId: "ECO-1"
    })).rejects.toThrow(/Failed immutable Jira provisioning provenance/);
    const recovered = await service.reconcileUncertainProvisioningSlot({
      ecoIssueId: "66400", projectKey: "ECO",
      evidenceId: slot.evidenceId, issueKeyOrId: "ECO-100"
    });
    expect(recovered.slots[slot.evidenceId]?.stage).toBe("CREATED");
    const complete = await service.provisionLiveJiraWorkspace(request);
    expect(complete.evidenceIntegrity).toHaveLength(6);
    expect(jira.createCount).toBe(6);
  });

  it("uses admin-configured immutable Jira issue-type IDs and excludes config rows from Fleet", async () => {
    const { store, jira, service } = await makeRig();
    const config = await service.configureProjectGovernance({
      projectKey: "ECO",
      callerAccountId: "acct-admin",
      governedIssueTypeIds: ["10200"]
    });
    expect(config.revisionSeq).toBe(1);
    expect((await store.getProjectGovernanceConfig("ECO"))?.governedIssueTypeIds).toEqual(["10200"]);
    jira.issues.set("99001", {
      issueId: "99001", issueKey: "ECO-55", projectKey: "ECO",
      issueTypeId: "10200", issueTypeName: "Task", // mutable display name is not trusted
      summary: "Uninitialized governed issue", description: "",
      statusCategoryKey: "new", resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS, structuredFields: {}
    });
    jira.issues.set("99002", {
      issueId: "99002", issueKey: "ECO-56", projectKey: "ECO",
      issueTypeId: "10000", issueTypeName: "Engineering Change Order",
      summary: "Unrelated task with misleading name", description: "",
      statusCategoryKey: "new", resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS, structuredFields: {}
    });
    expect((await service.validateReleaseTransition({
      projectKey: "ECO", ecoIssueId: "99001", actorAccountId: "acct-admin"
    })).result).toBe(false);
    expect((await service.validateReleaseTransition({
      projectKey: "ECO", ecoIssueId: "99002", actorAccountId: "acct-admin"
    })).result).toBe(true);
    expect(await store.listEcoWorkspaces()).toHaveLength(0);
  });

  it("fails closed if a governed ECO is moved to a different Jira project", async () => {
    const { service, jira, request } = await makeRig();
    const initial = await service.provisionLiveJiraWorkspace(request);
    expect(initial.workspace?.eco.projectKey).toBe("ECO");
    expect(initial.workspace?.eco.projectId).toBe("10010");
    const issue = jira.issues.get("66400")!;
    jira.issues.set("66400", {
      ...issue, projectKey: "OTHER", projectId: "20099", issueKey: "OTHER-1"
    });
    const moved = await service.validateReleaseTransition({
      projectKey: "OTHER", ecoIssueId: "66400", actorAccountId: "acct-admin"
    });
    expect(moved.result).toBe(false);
    expect(moved.errorMessage).toContain("project identity changed");
    const stale = await service.validateReleaseTransition({
      projectKey: "ECO", ecoIssueId: "66400", actorAccountId: "acct-admin"
    });
    expect(stale.result).toBe(false);
  });

  it("rejects concurrent provisioning without duplicate ticket creation", async () => {
    const { jira, service, request } = await makeRig();
    const runs = await Promise.allSettled([
      service.provisionLiveJiraWorkspace(request),
      service.provisionLiveJiraWorkspace(request)
    ]);
    expect(runs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(runs.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(jira.createCount).toBe(6);
  });
});
