import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { LiveJiraIssueProjection } from "../src/core/index";
import {
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

class MultiEcoJiraGatewayStub implements JiraPlatformGateway {
  private nextId = 88000;
  public readonly issuesById = new Map<string, LiveJiraIssueProjection & { projectKey: string }>();

  constructor() {
    this.issuesById.set("66401", {
      issueId: "66401",
      issueKey: "ECO-1",
      projectKey: "ECO",
      summary: "Helios EV Traction Battery Pack ECO",
      description: "Automotive EV Powertrain ECO",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      structuredFields: {}
    });
    this.issuesById.set("66402", {
      issueId: "66402",
      issueKey: "ECO-2",
      projectKey: "ECO",
      summary: "PulseGuard Class III Infusion Pump ECO",
      description: "MedTech IEC 60601-2-24 ECO",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 1_000,
      structuredFields: {}
    });
    this.issuesById.set("66403", {
      issueId: "66403",
      issueKey: "ECO-3",
      projectKey: "ECO",
      summary: "Aegis Primary Flight Actuator ECO",
      description: "Aerospace DO-160G ECO",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 2_000,
      structuredFields: {}
    });
    this.issuesById.set("66499", {
      issueId: "66499",
      issueKey: "OTHER-1",
      projectKey: "OTHER",
      summary: "Unrelated Space ECO",
      description: "Separate Jira project space",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 3_000,
      structuredFields: {}
    });
    // Existing custom test protocol ticket in Done status + one in In Progress
    this.issuesById.set("70001", {
      issueId: "70001",
      issueKey: "ECO-77",
      projectKey: "ECO",
      issueTypeName: "Task",
      summary: "External Lab ISO/IEC 17025 HV Thermal Ripple Protocol Report #77",
      description: "Signed external chamber report for VAR_400V HV ripple.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 50_000,
      structuredFields: {}
    });
    this.issuesById.set("70002", {
      issueId: "70002",
      issueKey: "ECO-78",
      projectKey: "ECO",
      summary: "Draft Unexecuted Test Ticket",
      description: "Still in progress.",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 50_000,
      structuredFields: {}
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

  public async fetchProjectRoleMembers(): Promise<Record<string, readonly string[]>> {
    return {
      ...createHeliosTrustedRoles(),
      Administrators: ["acct-admin-1"]
    };
  }

  public async provisionVerificationIssues(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly specs: readonly VerificationIssueSeedSpec[];
    readonly onCreatedBeforeTransition?: (createdIssueIds: readonly string[]) => Promise<void>;
  }): Promise<readonly ProvisionedVerificationIssue[]> {
    const created: ProvisionedVerificationIssue[] = [];
    const ids: string[] = [];
    for (const spec of params.specs) {
      const id = String(++this.nextId);
      const key = `${params.projectKey}-${this.nextId}`;
      const live: LiveJiraIssueProjection & { projectKey: string } = {
        issueId: id,
        issueKey: key,
        projectKey: params.projectKey,
        issueTypeName: "Task",
        summary: spec.summary,
        description: spec.description,
        statusCategoryKey: "done",
        resolutionName: "Done",
        updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + this.nextId,
        structuredFields: {}
      };
      this.issuesById.set(id, live);
      ids.push(id);
      const { projectKey: _p, ...proj } = live;
      created.push({ evidenceId: spec.evidenceId, liveIssue: proj });
    }
    if (params.onCreatedBeforeTransition) {
      await params.onCreatedBeforeTransition(ids);
    }
    return created;
  }

  public async probeConnectivity(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<ConnectivityProbeResult> {
    return {
      ok: true,
      checkedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      callerAccountId: "acct-admin-1",
      callerDisplayName: "Admin Tester",
      jiraServerBaseUrl: "https://example.atlassian.net",
      jiraDeploymentType: "Cloud",
      issueReachable: this.issuesById.has(params.issueId),
      resolvedRoleCount: 4,
      diagnostics: ["OK"]
    };
  }
}

function buildPhase4Harness() {
  let clock = HELIOS_BASE_EPOCH_MS + 100_000;
  const sql = new SimulatedTiDbSqlClient({ clusterEnabled: true });
  const provisioning = new SqlProvisioningManager({
    sqlClient: sql,
    migrationRunner: new SdkMigrationRunner(sql),
    now: () => ++clock
  });
  const store = new ForgeSqlCasStore(sql);
  const jira = new MultiEcoJiraGatewayStub();
  const service = new LineLockService({
    store,
    jira,
    provisioning,
    now: () => ++clock
  });
  const rovo = createRovoActionHandlers({ service, jira });
  return { sql, provisioning, store, jira, service, rovo };
}

describe("Phase 4: Multi-Industry Templates, Custom Authoring Studio, Live Jira Binding & Space-Wide Fleet Portfolio", () => {
  it("ignores stale global evidence registry grants for an uninitialized ECO and allows ordinary Tasks", async () => {
    const { service, store, jira, provisioning } = buildPhase4Harness();
    await provisioning.runMigrations("install");
    const live = {
      projectKey: "ECO",
      description: "Attempted evidence-registration bypass",
      statusCategoryKey: "new",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      structuredFields: {}
    } as const;
    jira.issuesById.set("99700", {
      ...live,
      issueId: "99700",
      issueKey: "ECO-99",
      issueTypeName: "Engineering Change Order",
      summary: "Uninitialized governed ECO"
    });
    jira.issuesById.set("99701", {
      ...live,
      issueId: "99701",
      issueKey: "ECO-100",
      issueTypeName: "Task",
      summary: "Unrelated Jira work item"
    });

    // Legacy installations can contain stale globally registered IDs.
    await store.registerEvidenceIssueIds(["99700"]);
    const governed = await service.validateReleaseTransition({
      projectKey: "ECO", ecoIssueId: "99700", actorAccountId: "acct-author"
    });
    expect(governed.result).toBe(false);
    expect(governed.errorMessage).toContain("No initialized");

    const ordinaryTask = await service.validateReleaseTransition({
      projectKey: "ECO", ecoIssueId: "99701", actorAccountId: "acct-author"
    });
    expect(ordinaryTask.result).toBe(true);
    await expect(service.getProjectFleetOverview({ projectKey: "*" })).rejects.toThrow(
      "valid, explicit Jira project key"
    );
  });

  it("provisions MedTech Class III IEC 60601 Infusion Pump and verifies Adult ICU carry-forward vs Neonatal NICU Strong Kleene K3 FALSE block", async () => {
    const { service } = buildPhase4Harness();

    const initial = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66402",
      ecoIssueKey: "ECO-2",
      callerAccountId: "acct-author",
      templateId: "MEDTECH_INFUSION_PUMP"
    });

    expect(initial.workspace?.catalog.familyId).toBe("PULSEGUARD-INFUSION-2026");
    expect(initial.evaluation?.gateState).toBe("AWAITING_ATTESTATION");
    expect(initial.evidenceIntegrity?.every((r) => r.statusIsDone && r.hashMatches)).toBe(true);

    // Proposing +/-2.4% Flow Sensor Rev B on ALL channels violates Neonatal NICU (<=1.8% tol) while satisfying Adult ICU (<=3.0% tol)
    const blockedAll = await service.applyScenarioPreset({
      projectKey: "ECO",
      ecoIssueId: "66402",
      expectedRevisionSeq: initial.workspace!.revisionSeq,
      callerAccountId: "acct-author",
      presetId: "CAP_REV_C_ALL_5000"
    });

    expect(blockedAll.evaluation?.gateState).toBe("BLOCKED_INVALIDATED");
    const nicuFlow = blockedAll.evaluation?.sliceObligations.find(
      (s) => s.variantId === "VAR_NEONATAL_NICU" && s.interval.serialFrom === 5000 && s.obligationId === "OBL_MED_FLOW"
    );
    const adultFlow = blockedAll.evaluation?.sliceObligations.find(
      (s) => s.variantId === "VAR_ADULT_ICU" && s.interval.serialFrom === 5000 && s.obligationId === "OBL_MED_FLOW"
    );
    expect(nicuFlow?.status).toBe("INVALIDATED_PREDICATE_FALSE");
    expect(nicuFlow?.validityTrace?.value).toBe("FALSE");
    expect(adultFlow?.status).toBe("SUPPORTED_BY_APPROVED_RULE");
    expect(adultFlow?.appliedCarryForwardRuleId).toBe("CFR-MED-FLOW-ADULT");

    await expect(service.simulateCounterfactual({
      projectKey: "ECO",
      ecoIssueId: "66402",
      request: {
        kind: "GATE_DRIVER_REV_B_CUTOVER",
        targetVariants: "ALL",
        serialFrom: 5000
      }
    })).rejects.toThrow(/Automotive EV operation/);

    // Scoping Flow Sensor Rev B strictly to VAR_ADULT_ICU eliminates physical retests!
    const scopedAdult = await service.applyScenarioPreset({
      projectKey: "ECO",
      ecoIssueId: "66402",
      expectedRevisionSeq: blockedAll.workspace!.revisionSeq,
      callerAccountId: "acct-author",
      presetId: "CAP_REV_C_400V_5000"
    });
    expect(scopedAdult.evaluation?.gateState).toBe("AWAITING_ATTESTATION");
    expect(scopedAdult.evaluation?.remediationPlans).toHaveLength(0);
    // B1 (ALM Suspect Graph) & B2 (PLM Version+Env) falsely block the Adult ICU carry-forward slice, whereas LineLock supports 9/9!
    expect(scopedAdult.baselineSummary?.linelockSupported).toBe(9);
    expect(scopedAdult.baselineSummary?.b2Supported).toBeLessThan(9);
  });

  it("provisions Aerospace DO-160G Flight Actuator and verifies Regional -40C carry-forward vs Stratospheric -55C cold-soak block", async () => {
    const { service, rovo } = buildPhase4Harness();

    const initial = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66403",
      ecoIssueKey: "ECO-3",
      callerAccountId: "acct-author",
      templateId: "AEROSPACE_FLIGHT_ACTUATOR"
    });
    expect(initial.workspace?.catalog.familyId).toBe("AEGIS-FLIGHT-EHA-2026");

    // Rovo/MCP counterfactual cutover on ALL variants shows Stratospheric -55C fails RSLV-AERO@B (-45C rated)
    const simAll = await rovo.simulateSerialCutover({
      issueKey: "ECO-3",
      variantScope: "ALL",
      serialFrom: 5000
    });
    expect(simAll.mutatedStorage).toBe(false);
    expect(simAll.delta.simulatedGateState).toBe("BLOCKED_INVALIDATED");
    expect(simAll.delta.simulatedRequiredRetests).toBe(1);

    // Rovo/MCP counterfactual scoped to VAR_REGIONAL_TURBOPROP (-40C) succeeds with 0 retests!
    const simReg = await rovo.simulateSerialCutover({
      issueKey: "ECO-3",
      variantScope: "VAR_REGIONAL_TURBOPROP",
      serialFrom: 5000
    });
    expect(simReg.delta.simulatedGateState).toBe("AWAITING_ATTESTATION");
    expect(simReg.delta.simulatedRequiredRetests).toBe(0);

    await expect(service.simulateCounterfactual({
      projectKey: "ECO",
      ecoIssueId: "66403",
      request: {
        kind: "CAP_REV_D_DRAFT_CUTOVER",
        targetVariants: "ALL",
        serialFrom: 5000
      }
    })).rejects.toThrow(/no corresponding draft resolver revision/);
  });

  it("authors custom APPROVED vs DRAFT components and binds existing Done Jira evidence tickets via CAS + generation increment", async () => {
    const { service } = buildPhase4Harness();

    const v0 = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66401",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-author",
      templateId: "AUTOMOTIVE_EV_HELIOS"
    });

    // 1. Author custom 1100V C0G APPROVED capacitor across ALL variants (400V & 800V) for lot [5000..8000) -> satisfies both CFR-400-CAP-SUB & CFR-800-CAP-SUB!
    const vCustomApproved = await service.authorCustomComponentSubstitution({
      projectKey: "ECO",
      ecoIssueId: "66401",
      expectedRevisionSeq: v0.workspace!.revisionSeq,
      callerAccountId: "acct-author",
      request: {
        partNumber: "CAP-CUSTOM-SIC",
        revision: "E",
        title: "Custom 1100V C0G SiC Snubber Capacitor",
        specStatus: "APPROVED",
        targetSlotPath: "HV_INV/DC_LINK_CAP_C14",
        primaryNumericAttrKey: "v_rated",
        primaryNumericValue: 1100,
        primaryNumericScale: 0,
        primaryNumericUnit: "V",
        secondaryEnumAttrKey: "dielectric",
        secondaryEnumValue: "C0G",
        targetVariants: "ALL",
        serialFrom: 5000,
        serialTo: 8000
      }
    });

    expect(vCustomApproved.evaluation?.gateState).toBe("AWAITING_ATTESTATION");
    expect(vCustomApproved.evaluation?.slices).toHaveLength(6); // [1000..5000), [5000..8000), [8000..+inf) x 2 variants
    expect(vCustomApproved.evaluation?.remediationPlans).toHaveLength(0);

    // 2. Authoring a DRAFT custom sample immediately triggers BLOCKED_STRUCTURAL
    const vCustomDraft = await service.authorCustomComponentSubstitution({
      projectKey: "ECO",
      ecoIssueId: "66401",
      expectedRevisionSeq: vCustomApproved.workspace!.revisionSeq,
      callerAccountId: "acct-author",
      request: {
        partNumber: "CAP-CUSTOM-PROTO",
        revision: "X1",
        title: "Unapproved Prototype Sample",
        specStatus: "DRAFT",
        targetSlotPath: "HV_INV/DC_LINK_CAP_C14",
        primaryNumericAttrKey: "v_rated",
        primaryNumericValue: 1200,
        primaryNumericScale: 0,
        primaryNumericUnit: "V",
        targetVariants: ["VAR_400V"],
        serialFrom: 5000,
        serialTo: null
      }
    });
    expect(vCustomDraft.evaluation?.gateState).toBe("BLOCKED_STRUCTURAL");

    // 3. Binding an In-Progress Jira ticket is rejected; binding Done ticket ECO-77 succeeds, pins SHA-256, and registers evidence pass-through
    await expect(
      service.bindCustomJiraEvidenceTicket({
        projectKey: "ECO",
        ecoIssueId: "66401",
        expectedRevisionSeq: vCustomDraft.workspace!.revisionSeq,
        callerAccountId: "acct-author",
        request: {
          evidenceId: "EV-400-RIPPLE",
          jiraIssueKeyOrId: "ECO-78"
        }
      })
    ).rejects.toThrow(/statusCategory is "done"/i);

    const prevGen = vCustomDraft.workspace!.eco.approvalGeneration;
    const vBound = await service.bindCustomJiraEvidenceTicket({
      projectKey: "ECO",
      ecoIssueId: "66401",
      expectedRevisionSeq: vCustomDraft.workspace!.revisionSeq,
      callerAccountId: "acct-author",
      request: {
        evidenceId: "EV-400-RIPPLE",
        jiraIssueKeyOrId: "ECO-77"
      }
    });
    expect(vBound.workspace?.eco.approvalGeneration).toBe(prevGen + 1);
    const boundRow = vBound.evidenceIntegrity?.find((r) => r.evidenceId === "EV-400-RIPPLE");
    expect(boundRow?.jiraIssueKey).toBe("ECO-77");
    expect(boundRow?.hashMatches).toBe(true);
    // Registered evidence pass-through allows workflow transitions on ECO-77
    const validatorRes = await service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "70001",
      actorAccountId: "acct-admin-1"
    });
    expect(validatorRes.result).toBe(true);
  });

  it("aggregates multi-industry ECO portfolio in getProjectFleetOverview and rovo inspectProjectFleet while isolating other Jira spaces", async () => {
    const { service, rovo } = buildPhase4Harness();

    // Provision 3 ECOs in space "ECO" across all 3 regulated hardware industries + 1 in space "OTHER"
    await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66401",
      ecoIssueKey: "ECO-1",
      callerAccountId: "acct-author",
      templateId: "AUTOMOTIVE_EV_HELIOS"
    });
    const medView = await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66402",
      ecoIssueKey: "ECO-2",
      callerAccountId: "acct-author",
      templateId: "MEDTECH_INFUSION_PUMP"
    });
    // Put ECO-2 into BLOCKED_INVALIDATED state
    await service.applyScenarioPreset({
      projectKey: "ECO",
      ecoIssueId: "66402",
      expectedRevisionSeq: medView.workspace!.revisionSeq,
      callerAccountId: "acct-author",
      presetId: "CAP_REV_C_ALL_5000"
    });
    await service.provisionLiveJiraWorkspace({
      projectKey: "ECO",
      ecoIssueId: "66403",
      ecoIssueKey: "ECO-3",
      callerAccountId: "acct-author",
      templateId: "AEROSPACE_FLIGHT_ACTUATOR"
    });
    await service.provisionLiveJiraWorkspace({
      projectKey: "OTHER",
      ecoIssueId: "66499",
      ecoIssueKey: "OTHER-1",
      callerAccountId: "acct-author",
      templateId: "AUTOMOTIVE_EV_HELIOS"
    });

    const fleet = await rovo.inspectProjectFleet({ projectKey: "ECO" });
    expect(fleet.authority).toBe("READ_ONLY_DETERMINISTIC_FLEET_KERNEL");
    expect(fleet.mutatedStorage).toBe(false);
    expect(fleet.totalEcos).toBe(3); // OTHER-1 isolated!
    expect(fleet.awaitingSignoffCount).toBe(2);
    expect(fleet.blockedCount).toBe(1);
    expect(fleet.verdictDistribution.invalidated).toBe(1);
    expect(fleet.verdictDistribution.supportedByRule).toBeGreaterThanOrEqual(1);
    expect(fleet.ecos.map((e) => e.ecoIssueKey).sort()).toEqual(["ECO-1", "ECO-2", "ECO-3"]);
  });
});
