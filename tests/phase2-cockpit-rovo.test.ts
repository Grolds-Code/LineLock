import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { LiveJiraIssueProjection } from "../src/core/index";
import {
  AuthorizationError,
  ForgeSqlCasStore,
  LineLockService,
  SimulatedTiDbSqlClient,
  SqlProvisioningManager,
  createRovoActionHandlers,
  type ConnectivityProbeResult,
  type JiraPlatformGateway,
  type MigrationRunnerLike,
  type ProvisionedVerificationIssue,
  type VerificationIssueSeedSpec
} from "../src/forge/index";
import { HELIOS_BASE_EPOCH_MS, createHeliosTrustedRoles } from "../src/scenarios/heliosBatteryPack";

const require = createRequire(import.meta.url);
const { MigrationRunner: SdkMigrationRunner } = require("@forge/sql/out/migration.js") as {
  MigrationRunner: new (client: unknown) => MigrationRunnerLike;
};

class LiveProvisioningJiraStub implements JiraPlatformGateway {
  private nextId = 66500;
  public readonly issuesById = new Map<string, LiveJiraIssueProjection & { projectKey: string }>();
  public readonly rolesByProject = new Map<string, Record<string, readonly string[]>>();

  constructor() {
    this.issuesById.set("66400", {
      issueId: "66400",
      issueKey: "ECO-1",
      projectKey: "ECO",
      summary: "Substitute CAP-1210 Rev C",
      description: "Live ECO on one-atlas-sadl.atlassian.net",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      structuredFields: {}
    });

    this.rolesByProject.set("ECO", {
      ...createHeliosTrustedRoles(),
      Administrators: ["acct-solo-admin"]
    });
  }

  public tamperIssueDescription(issueId: string, newDescription: string): void {
    const found = this.issuesById.get(issueId);
    if (!found) throw new Error(`Missing issue ${issueId}`);
    this.issuesById.set(issueId, {
      ...found,
      description: newDescription,
      updatedAtEpochMs: found.updatedAtEpochMs + 10_000
    });
  }

  public setIssueStatus(issueId: string, statusCategoryKey: string): void {
    const found = this.issuesById.get(issueId);
    if (!found) throw new Error(`Missing issue ${issueId}`);
    this.issuesById.set(issueId, {
      ...found,
      statusCategoryKey,
      updatedAtEpochMs: found.updatedAtEpochMs + 1_000
    });
  }

  public async fetchLiveIssue(issueId: string): Promise<LiveJiraIssueProjection> {
    const full = await this.fetchLiveIssueByKeyOrId(issueId);
    const { projectKey: _p, ...rest } = full;
    return rest;
  }

  public async fetchLiveIssueByKeyOrId(
    issueKeyOrId: string
  ): Promise<LiveJiraIssueProjection & { readonly projectKey: string }> {
    const direct = this.issuesById.get(issueKeyOrId);
    if (direct) return direct;
    for (const item of this.issuesById.values()) {
      if (item.issueKey.toUpperCase() === issueKeyOrId.toUpperCase()) {
        return item;
      }
    }
    throw new Error(`404 Issue ${issueKeyOrId} not found`);
  }

  public async fetchProjectRoleMembers(
    projectKey: string,
    requiredRoles: readonly string[]
  ): Promise<Record<string, readonly string[]>> {
    const map = this.rolesByProject.get(projectKey) ?? {};
    const out: Record<string, readonly string[]> = {};
    for (const r of requiredRoles) {
      out[r] = map[r] ?? [];
    }
    return out;
  }

  public async provisionVerificationIssues(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly specs: readonly VerificationIssueSeedSpec[];
  }): Promise<readonly ProvisionedVerificationIssue[]> {
    const created: ProvisionedVerificationIssue[] = [];
    let seq = 2;
    for (const spec of params.specs) {
      const id = String(this.nextId++);
      const key = `${params.projectKey}-${seq++}`;
      const live: LiveJiraIssueProjection & { projectKey: string } = {
        issueId: id,
        issueKey: key,
        projectKey: params.projectKey,
        summary: spec.summary,
        description: spec.description,
        statusCategoryKey: "done",
        resolutionName: "Done",
        updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + seq * 1000,
        structuredFields: {}
      };
      this.issuesById.set(id, live);
      const { projectKey: _ignored, ...proj } = live;
      created.push({
        evidenceId: spec.evidenceId,
        liveIssue: proj
      });
    }
    return created;
  }

  public async probeConnectivity(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<ConnectivityProbeResult> {
    const issue = await this.fetchLiveIssue(params.issueId);
    return {
      ok: Boolean(issue),
      checkedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      callerAccountId: "acct-solo-admin",
      callerDisplayName: "Solo Evaluator",
      jiraServerBaseUrl: "https://one-atlas-sadl.atlassian.net",
      jiraDeploymentType: "Cloud",
      issueReachable: true,
      resolvedRoleCount: 4,
      diagnostics: ["ok"]
    };
  }
}

describe("Phase 2 — Live Jira Provisioner, Counterfactual Simulator, Policy Governance & Rovo Read-Only Agent", () => {
  function setupPhase2Harness() {
    let clockMs = HELIOS_BASE_EPOCH_MS;
    const sqlClient = new SimulatedTiDbSqlClient({ clusterEnabled: true });
    const runner = new SdkMigrationRunner(sqlClient);
    const provisioning = new SqlProvisioningManager({
      sqlClient,
      migrationRunner: runner,
      now: () => clockMs
    });
    const store = new ForgeSqlCasStore(sqlClient);
    const jira = new LiveProvisioningJiraStub();
    const service = new LineLockService({
      store,
      jira,
      provisioning,
      now: () => {
        clockMs += 100;
        return clockMs;
      }
    });
    const rovo = createRovoActionHandlers({ service, jira });
    return { jira, store, service, rovo };
  }

  it("provisions 6 live Jira qualification tickets (ECO-2..ECO-7), verifies SHA-256 content pins, and catches live Jira tampering", async () => {
    const { jira, service } = setupPhase2Harness();

    const provisionedView = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66400",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-solo-admin"
    });

    expect(provisionedView.workspace?.revisionSeq).toBe(1);
    expect(provisionedView.evaluation?.gateState).toBe("AWAITING_ATTESTATION");
    expect(provisionedView.evidenceIntegrity).toHaveLength(6);
    expect(provisionedView.evidenceIntegrity?.every((r) => r.hashMatches && r.statusIsDone)).toBe(
      true
    );
    expect(provisionedView.evidenceIntegrity?.map((r) => r.jiraIssueKey)).toEqual([
      "ECO-2",
      "ECO-3",
      "ECO-4",
      "ECO-5",
      "ECO-6",
      "ECO-7"
    ]);

    // Judge tampers with ECO-2 description directly in Jira (status remains Done, timestamp newer)
    const eco2Id = provisionedView.evidenceIntegrity![0]!.jiraIssueId;
    jira.tamperIssueDescription(eco2Id, "Edited post-approval: lowered bus voltage to 200V!");

    const afterTamper = await service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "66400"
    });
    expect(afterTamper.evaluation?.gateState).toBe("BLOCKED_INVALIDATED");
    expect(afterTamper.evidenceIntegrity?.[0]?.hashMatches).toBe(false);
  });

  it("executes read-only counterfactual simulations and Rovo GET actions without mutating Forge SQL", async () => {
    const { service, rovo } = setupPhase2Harness();

    await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66400",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-solo-admin"
    });

    // Commit Cap Rev C on ALL variants -> blocks VAR_800V@5000..INF
    const afterAllRevC = await service.applyScenarioPreset({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: 1,
      callerAccountId: "acct-solo-admin",
      presetId: "CAP_REV_C_ALL_5000"
    });
    expect(afterAllRevC.workspace?.revisionSeq).toBe(2);
    expect(afterAllRevC.evaluation?.gateState).toBe("BLOCKED_INVALIDATED");

    // Rovo inspect action cites exact blockers
    const inspected = await rovo.inspectEcoAssurance({ issueKey: "ECO-1" });
    expect(inspected.authority).toBe("READ_ONLY_DETERMINISTIC_KERNEL");
    expect(inspected.gateState).toBe("BLOCKED_INVALIDATED");

    // Rovo counterfactual action simulates scoping Rev C to VAR_400V from SN 5000 -> 0 retests, 0 SQL writes!
    const simOut = await rovo.simulateSerialCutover({
      issueKey: "ECO-1",
      variantScope: "VAR_400V",
      serialFrom: 5000
    });
    expect(simOut.mutatedStorage).toBe(false);
    expect(simOut.delta.currentGateState).toBe("BLOCKED_INVALIDATED");
    expect(simOut.delta.simulatedGateState).toBe("AWAITING_ATTESTATION");
    expect(simOut.delta.currentRequiredRetests).toBe(1);
    expect(simOut.delta.simulatedRequiredRetests).toBe(0);

    // Rovo baseline audit exposes B0 / B1 / B2 discrepancies on ECO-1
    const baseAudit = await rovo.compareBaselines({ issueKey: "ECO-1" });
    expect(baseAudit.discrepancyCount).toBeGreaterThan(0);

    // Verify Forge SQL revisionSeq is STILL 2 (zero storage mutation from simulations/Rovo!)
    const checkUnmutated = await service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "66400"
    });
    expect(checkUnmutated.workspace?.revisionSeq).toBe(2);
  });

  it("enforces Production SoD rejection, then allows audited Policy v2 switch for full solo-evaluator verified release", async () => {
    const { jira, service } = setupPhase2Harness();

    const v1 = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66400",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-solo-admin"
    });

    // Under default Policy v1 (enforceSeparationOfDuties: true), solo author is rejected
    await expect(
      service.recordHumanAttestation({
        projectKey: "ECO",
        ecoIssueId: "66400",
        expectedRevisionSeq: v1.workspace!.revisionSeq,
        expectedSnapshotSha256: v1.evaluation!.snapshotSha256,
        expectedApprovalGeneration: 1,
        signerAccountId: "acct-solo-admin",
        roleName: "Lead Engineers",
        rationale: "Attempt self-sign under Production SoD"
      })
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Audited switch to DEMO_SOLO_ADMIN increments BOTH policyVersion (1->2) and approvalGeneration (1->2)
    const v2 = await service.switchGovernancePolicyMode({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: 1,
      callerAccountId: "acct-solo-admin",
      mode: "DEMO_SOLO_ADMIN"
    });
    expect(v2.workspace?.catalog.policy.policyVersion).toBe(2);
    expect(v2.workspace?.eco.approvalGeneration).toBe(2);

    // Sign Administrators role at generation 2 -> READY_FOR_RELEASE_TRANSITION
    const signed = await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: v2.workspace!.revisionSeq,
      expectedSnapshotSha256: v2.evaluation!.snapshotSha256,
      expectedApprovalGeneration: 2,
      signerAccountId: "acct-solo-admin",
      roleName: "Administrators",
      rationale: "Solo demo evaluator verified all 6 live Jira qualification hashes."
    });
    expect(signed.evaluation.gateState).toBe("READY_FOR_RELEASE_TRANSITION");

    // Complete 2-phase workflow transition -> RELEASE_TRANSITIONED_VERIFIED
    const valRes = await service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "66400",
      actorAccountId: "acct-solo-admin"
    });
    expect(valRes.result).toBe(true);

    jira.setIssueStatus("66400", "done");
    const finalized = await service.reconcileIssueUpdatedEvent({
      projectKey: "ECO",
      updatedIssueId: "66400"
    });
    expect(finalized?.gateState).toBe("RELEASE_TRANSITIONED_VERIFIED");
  });
});
