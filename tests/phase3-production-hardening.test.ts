import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseAssuranceMarkdown, type LiveJiraIssueProjection } from "../src/core/index";
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

class GroupAwareJiraGatewayStub implements JiraPlatformGateway {
  private nextId = 77000;
  public readonly issuesById = new Map<string, LiveJiraIssueProjection & { projectKey: string }>();
  public readonly directRoleUsers = new Map<string, Record<string, readonly string[]>>();
  public readonly roleGroups = new Map<string, Record<string, readonly string[]>>();
  public readonly userGroups = new Map<string, readonly string[]>();
  public readonly postedComments: { issueIdOrKey: string; markdownText: string }[] = [];

  constructor() {
    this.issuesById.set("66400", {
      issueId: "66400",
      issueKey: "ECO-1",
      projectKey: "ECO",
      summary: "Substitute CAP-1210 Rev C",
      description: "Helios EV Battery Pack ECO",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      structuredFields: {}
    });

    // Simulate real Jira Cloud default: Administrators role has ZERO direct user actors,
    // only group actor "jira-admins-tenant"!
    this.directRoleUsers.set("ECO", {
      ...createHeliosTrustedRoles(),
      Administrators: []
    });
    this.roleGroups.set("ECO", {
      Administrators: ["jira-admins-tenant"]
    });
    this.userGroups.set("acct-group-admin-lead", ["jira-software-users", "jira-admins-tenant"]);
    this.userGroups.set("acct-unprivileged-dev", ["jira-software-users"]);
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

  public tamperIssueDescription(issueId: string, newDescription: string): void {
    const found = this.issuesById.get(issueId);
    if (!found) throw new Error(`Missing issue ${issueId}`);
    this.issuesById.set(issueId, {
      ...found,
      description: newDescription,
      updatedAtEpochMs: found.updatedAtEpochMs + 5_000
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
    requiredRoles: readonly string[],
    candidateAccountIds: readonly string[] = []
  ): Promise<Record<string, readonly string[]>> {
    const directMap = this.directRoleUsers.get(projectKey) ?? {};
    const groupMap = this.roleGroups.get(projectKey) ?? {};
    const out: Record<string, readonly string[]> = {};

    for (const roleName of requiredRoles) {
      const members = new Set<string>(directMap[roleName] ?? []);
      const allowedGroups = new Set(
        (groupMap[roleName] ?? []).map((g) => g.toLowerCase())
      );
      if (allowedGroups.size > 0) {
        for (const candidateId of candidateAccountIds) {
          const uGroups = this.userGroups.get(candidateId) ?? [];
          if (uGroups.some((ug) => allowedGroups.has(ug.toLowerCase()))) {
            members.add(candidateId);
          }
        }
      }
      out[roleName] = [...members].sort();
    }
    return out;
  }

  public async provisionVerificationIssues(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly specs: readonly VerificationIssueSeedSpec[];
    readonly onCreatedBeforeTransition?: (createdIssueIds: readonly string[]) => Promise<void>;
  }): Promise<readonly ProvisionedVerificationIssue[]> {
    const created: { evidenceId: string; id: string; key: string }[] = [];
    let seq = 8;
    for (const spec of params.specs) {
      const id = String(this.nextId++);
      const key = `${params.projectKey}-${seq++}`;
      this.issuesById.set(id, {
        issueId: id,
        issueKey: key,
        projectKey: params.projectKey,
        issueTypeName: "Task",
        summary: spec.summary,
        description: spec.description,
        statusCategoryKey: "new",
        resolutionName: null,
        updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 1_000,
        structuredFields: {}
      });
      created.push({ evidenceId: spec.evidenceId, id, key });
    }

    if (params.onCreatedBeforeTransition) {
      await params.onCreatedBeforeTransition(created.map((c) => c.id));
    }

    const out: ProvisionedVerificationIssue[] = [];
    for (const item of created) {
      this.setIssueStatus(item.id, "done");
      const liveIssue = await this.fetchLiveIssue(item.id);
      out.push({ evidenceId: item.evidenceId, liveIssue });
    }
    return out;
  }

  public async postIssueComment(params: {
    readonly issueIdOrKey: string;
    readonly markdownText: string;
  }): Promise<{ readonly commentId: string }> {
    this.postedComments.push(params);
    return { commentId: String(9900 + this.postedComments.length) };
  }

  public async probeConnectivity(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<ConnectivityProbeResult> {
    return {
      ok: true,
      checkedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      callerAccountId: "acct-group-admin-lead",
      callerDisplayName: "Principal Release Engineer",
      jiraServerBaseUrl: "https://helios-industrial.atlassian.net",
      jiraDeploymentType: "Cloud",
      issueReachable: this.issuesById.has(params.issueId),
      resolvedRoleCount: 4,
      diagnostics: [`ok:${params.projectKey}`]
    };
  }
}

function buildPhase3Rig() {
  let clockMs = HELIOS_BASE_EPOCH_MS + 100_000;
  const sql = new SimulatedTiDbSqlClient();
  const store = new ForgeSqlCasStore(sql);
  const provisioning = new SqlProvisioningManager({
    sqlClient: sql,
    migrationRunner: new SdkMigrationRunner(sql),
    now: () => clockMs
  });
  const jira = new GroupAwareJiraGatewayStub();
  const service = new LineLockService({
    store,
    jira,
    provisioning,
    now: () => clockMs
  });
  const rovo = createRovoActionHandlers({ service, jira });

  return {
    service,
    jira,
    store,
    provisioning,
    rovo,
    advanceClock: (ms: number) => {
      clockMs += ms;
    }
  };
}

describe("Phase 3 Championship Hardening: Group-Role RBAC, Zero-Latency Receipt Promotion, Parametric Lot Splitting & Live Re-Pinning", () => {
  it("preserves the correct industry disposition authority when restoring production governance", async () => {
    const cases = [
      ["AUTOMOTIVE_EV_HELIOS", "Power Electronics Disposition Authority"],
      ["MEDTECH_INFUSION_PUMP", "Clinical Risk Disposition Authority"],
      ["AEROSPACE_FLIGHT_ACTUATOR", "Airworthiness Disposition Authority"]
    ] as const;

    for (const [templateId, expectedRole] of cases) {
      const { service, provisioning } = buildPhase3Rig();
      await provisioning.runMigrations("install");
      const seeded = await service.seedReferenceWorkspace({
        ecoIssueId: "66400",
        ecoIssueKey: "ECO-1",
        callerAccountId: "acct-group-admin-lead",
        templateId
      });
      const demo = await service.switchGovernancePolicyMode({
        projectKey: "ECO",
        ecoIssueId: "66400",
        expectedRevisionSeq: seeded.revisionSeq,
        callerAccountId: "acct-group-admin-lead",
        mode: "DEMO_SOLO_ADMIN"
      });
      expect(demo.workspace?.catalog.policy.carryForwardDispositionRole).toBe("Administrators");

      const restored = await service.switchGovernancePolicyMode({
        projectKey: "ECO",
        ecoIssueId: "66400",
        expectedRevisionSeq: demo.workspace!.revisionSeq,
        callerAccountId: "acct-group-admin-lead",
        mode: "PRODUCTION_MULTI_ROLE"
      });
      expect(restored.workspace?.catalog.policy.carryForwardDispositionRole).toBe(expectedRole);
      expect(restored.workspace?.catalog.policy.enforceSeparationOfDuties).toBe(true);
    }
  });

  it("resolves Jira group-role actors for signing, blocks unprivileged users, and revokes trust live if group membership is removed before Done", async () => {
    const { service, jira, provisioning, store } = buildPhase3Rig();
    await provisioning.runMigrations("install");

    const seeded = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66400",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-group-admin-lead"
    });
    expect(seeded.evaluation?.gateState).toBe("AWAITING_ATTESTATION");

    await expect(
      service.switchGovernancePolicyMode({
        projectKey: "ECO",
        ecoIssueId: "66400",
        expectedRevisionSeq: seeded.workspace!.revisionSeq,
        callerAccountId: "acct-unprivileged-dev",
        mode: "DEMO_SOLO_ADMIN"
      })
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect((await store.getEcoWorkspace("66400"))?.revisionSeq).toBe(
      seeded.workspace!.revisionSeq
    );

    const soloView = await service.switchGovernancePolicyMode({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: seeded.workspace!.revisionSeq,
      callerAccountId: "acct-group-admin-lead",
      mode: "DEMO_SOLO_ADMIN"
    });

    // Unprivileged user not in `jira-admins-tenant` is deterministically rejected
    await expect(
      service.recordHumanAttestation({
        projectKey: "ECO",
        ecoIssueId: "66400",
        expectedRevisionSeq: soloView.workspace!.revisionSeq,
        expectedSnapshotSha256: soloView.evaluation!.snapshotSha256,
        expectedApprovalGeneration: soloView.workspace!.eco.approvalGeneration,
        signerAccountId: "acct-unprivileged-dev",
        roleName: "Administrators",
        rationale: "Attempted unauthorized signoff"
      })
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Group-assigned admin (`jira-admins-tenant`) signs out-of-the-box without direct user-actor setup
    const signed = await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: soloView.workspace!.revisionSeq,
      expectedSnapshotSha256: soloView.evaluation!.snapshotSha256,
      expectedApprovalGeneration: soloView.workspace!.eco.approvalGeneration,
      signerAccountId: "acct-group-admin-lead",
      roleName: "Administrators",
      rationale: "Verified via default Jira admin group actor."
    });
    expect(signed.evaluation.gateState).toBe("READY_FOR_RELEASE_TRANSITION");

    // If removed from `jira-admins-tenant` BEFORE transition, live workflow validator revokes trust and blocks!
    jira.userGroups.set("acct-group-admin-lead", ["jira-software-users"]);
    const blockedGate = await service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "66400",
      actorAccountId: "acct-group-admin-lead"
    });
    expect(blockedGate.result).toBe(false);
    expect(blockedGate.errorMessage).toContain("AWAITING_ATTESTATION");
  });

  it("promotes PendingTransitionIntent to FinalizedReleaseReceipt immediately on getWorkspaceView once Jira reaches Done, while keeping aborted transitions unfinalized", async () => {
    const { service, jira, provisioning } = buildPhase3Rig();
    await provisioning.runMigrations("install");

    const seeded = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66400",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-group-admin-lead"
    });
    const solo = await service.switchGovernancePolicyMode({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: seeded.workspace!.revisionSeq,
      callerAccountId: "acct-group-admin-lead",
      mode: "DEMO_SOLO_ADMIN"
    });
    await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: solo.workspace!.revisionSeq,
      expectedSnapshotSha256: solo.evaluation!.snapshotSha256,
      expectedApprovalGeneration: solo.workspace!.eco.approvalGeneration,
      signerAccountId: "acct-group-admin-lead",
      roleName: "Administrators",
      rationale: "Ready for release."
    });

    const gateRes = await service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "66400",
      actorAccountId: "acct-group-admin-lead"
    });
    expect(gateRes.result).toBe(true);

    // Before Jira commits Done (e.g. if transition aborts downstream), receipt is NOT created
    const whileInProgress = await service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "66400",
      callerAccountId: "acct-group-admin-lead"
    });
    expect(whileInProgress.workspace?.finalizedReleaseReceipt).toBeNull();
    expect(whileInProgress.evaluation?.gateState).toBe("READY_FOR_RELEASE_TRANSITION");

    // Jira commits Done, and user refreshes BEFORE async avi:jira:updated:issue arrives:
    jira.setIssueStatus("66400", "done");
    const refreshedImmediately = await service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "66400",
      callerAccountId: "acct-group-admin-lead"
    });
    expect(refreshedImmediately.evaluation?.gateState).toBe("RELEASE_TRANSITIONED_VERIFIED");
    expect(refreshedImmediately.workspace?.finalizedReleaseReceipt?.receiptId).toMatch(/^receipt-/);
  });

  it("evaluates parametric lot-bounded [SN 3500..7000) 3-way splits, DRAFT component structural blocks, and uncovered governed-slot substitutions", async () => {
    const { service, provisioning, rovo } = buildPhase3Rig();
    await provisioning.runMigrations("install");
    await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66400",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-group-admin-lead"
    });

    // 1. Temporary lot deviation [SN 3500..7000) on VAR_400V splits VAR_400V into 3 slices + VAR_800V into 1 slice = 4 slices!
    const lotBoundedSim = await service.simulateCounterfactual({
      projectKey: "ECO",
      ecoIssueId: "66400",
      request: {
        kind: "CAP_REV_C_CUTOVER",
        targetVariants: ["VAR_400V"],
        serialFrom: 3500,
        serialTo: 7000
      },
      includeBaselines: true
    });
    expect(lotBoundedSim.simulatedEvaluation.slices.map((s) => s.sliceId)).toEqual([
      "VAR_400V@1000..3500",
      "VAR_400V@3500..7000",
      "VAR_400V@7000..INF",
      "VAR_800V@1000..INF"
    ]);
    expect(lotBoundedSim.delta.simulatedBlockedCount).toBe(0);
    expect(lotBoundedSim.delta.simulatedSupportedCount).toBe(12);
    // Rovo simulateSerialCutover also supports lot-bounded serialTo:
    const rovoLotSim = await rovo.simulateSerialCutover({
      issueKey: "ECO-1",
      variantScope: "VAR_400V",
      serialFrom: 3500,
      serialTo: 7000
    });
    expect(rovoLotSim.simulatedParameters.serialTo).toBe(7000);
    expect(rovoLotSim.delta.simulatedBlockedCount).toBe(0);

    // 2. Unapproved engineering sample CAP-1210@D_DRAFT triggers BLOCKED_STRUCTURAL
    const draftSim = await service.simulateCounterfactual({
      projectKey: "ECO",
      ecoIssueId: "66400",
      request: {
        kind: "CAP_REV_D_DRAFT_CUTOVER",
        targetVariants: ["VAR_800V"],
        serialFrom: 5000
      }
    });
    expect(draftSim.simulatedEvaluation.gateState).toBe("BLOCKED_STRUCTURAL");

    // 3. Gate Driver DRV-ISO@B mutates governed slot outside carry-forward changeableSlots -> INVALIDATED_UNCOVERED_CHANGE
    const drvSim = await service.simulateCounterfactual({
      projectKey: "ECO",
      ecoIssueId: "66400",
      request: {
        kind: "GATE_DRIVER_REV_B_CUTOVER",
        targetVariants: ["VAR_400V"],
        serialFrom: 4000,
        serialTo: 6000
      }
    });
    expect(drvSim.simulatedEvaluation.gateState).toBe("BLOCKED_INVALIDATED");
    const middleRipple = drvSim.simulatedEvaluation.sliceObligations.find(
      (s) => s.sliceId === "VAR_400V@4000..6000" && s.obligationCode === "OBL-HV-RIPPLE"
    );
    expect(middleRipple?.status).toBe("INVALIDATED_UNCOVERED_CHANGE");
  });

  it("enforces live Jira tamper detection -> refuses re-pin if non-Done -> increments approvalGeneration on legitimate re-pin to invalidate prior signatures, and exports deterministic audit Markdown", async () => {
    const { service, jira, provisioning } = buildPhase3Rig();
    await provisioning.runMigrations("install");

    const seeded = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66400",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-group-admin-lead"
    });
    const solo = await service.switchGovernancePolicyMode({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: seeded.workspace!.revisionSeq,
      callerAccountId: "acct-group-admin-lead",
      mode: "DEMO_SOLO_ADMIN"
    });
    const signed = await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: solo.workspace!.revisionSeq,
      expectedSnapshotSha256: solo.evaluation!.snapshotSha256,
      expectedApprovalGeneration: solo.workspace!.eco.approvalGeneration,
      signerAccountId: "acct-group-admin-lead",
      roleName: "Administrators",
      rationale: "Initial qualification approval."
    });
    expect(signed.evaluation.gateState).toBe("READY_FOR_RELEASE_TRANSITION");

    // Tamper with ECO-8 in Jira -> immediate INVALIDATED_EVIDENCE_DRIFT!
    const eco8Id = signed.workspace.catalog.evidenceRecords[0]!.jiraIssueId;
    jira.tamperIssueDescription(eco8Id, "Updated chamber thermocouple calibration log v2.");
    const driftedView = await service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "66400",
      callerAccountId: "acct-group-admin-lead"
    });
    expect(driftedView.evaluation?.gateState).toBe("BLOCKED_INVALIDATED");
    expect(driftedView.evidenceIntegrity?.[0]?.hashMatches).toBe(false);

    // If ECO-8 is reopened (`indeterminate`), re-pinning is strictly refused!
    jira.setIssueStatus(eco8Id, "indeterminate");
    await expect(
      service.repinLiveEvidenceHashes({
        projectKey: "ECO",
        ecoIssueId: "66400",
        expectedRevisionSeq: driftedView.workspace!.revisionSeq,
        callerAccountId: "acct-group-admin-lead"
      })
    ).rejects.toThrow(/must be "done"/);

    // Return ECO-8 to Done and re-pin -> hashes match again, AND approvalGeneration increments
    // so the pre-tamper attestation is invalidated and requires fresh human signoff!
    jira.setIssueStatus(eco8Id, "done");
    const repinned = await service.repinLiveEvidenceHashes({
      projectKey: "ECO",
      ecoIssueId: "66400",
      expectedRevisionSeq: driftedView.workspace!.revisionSeq,
      callerAccountId: "acct-group-admin-lead"
    });
    expect(repinned.evidenceIntegrity?.every((r) => r.hashMatches)).toBe(true);
    expect(repinned.workspace?.eco.approvalGeneration).toBe(
      driftedView.workspace!.eco.approvalGeneration + 1
    );
    expect(repinned.evaluation?.gateState).toBe("AWAITING_ATTESTATION");
    expect(repinned.evaluation?.attestationSummary.rejectedReasons.length).toBeGreaterThan(0);

    // Deterministic Release Assurance Markdown is byte-for-byte reproducible and exports to Jira comment
    const md1 = buildReleaseAssuranceMarkdown({
      catalog: repinned.workspace!.catalog,
      eco: repinned.workspace!.eco,
      evaluation: repinned.evaluation!,
      finalizedReceipt: repinned.workspace!.finalizedReleaseReceipt
    });
    const md2 = buildReleaseAssuranceMarkdown({
      catalog: repinned.workspace!.catalog,
      eco: repinned.workspace!.eco,
      evaluation: repinned.evaluation!,
      finalizedReceipt: repinned.workspace!.finalizedReleaseReceipt
    });
    expect(md1).toBe(md2);
    expect(md1).toContain("Scope Notice:");
    expect(md1).toContain(repinned.evaluation!.snapshotSha256);

    const commentRes = await service.postAuditRecordComment({
      projectKey: "ECO",
      ecoIssueId: "66400",
      callerAccountId: "acct-group-admin-lead"
    });
    expect(commentRes.commentId).toBe("9901");
    expect(jira.postedComments).toHaveLength(1);
    expect(jira.postedComments[0]?.issueIdOrKey).toBe("ECO-1");
  });

  it("maintains strict architectural purity in src/core (zero @forge/*, fetch, or Date.now imports)", () => {
    const coreDir = join(process.cwd(), "src", "core");
    const files = readdirSync(coreDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(8);

    for (const file of files) {
      const content = readFileSync(join(coreDir, file), "utf8");
      expect(content).not.toMatch(/@forge\//);
      expect(content).not.toMatch(/\bfetch\s*\(/);
      expect(content).not.toMatch(/Date\.now\s*\(/);
    }
  });
});
