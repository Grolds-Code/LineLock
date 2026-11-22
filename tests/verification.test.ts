import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ForgeSQLAPIError, errorCodes } from "@forge/sql";
import {
  canonicalizeJson,
  computePinnedIssueStateHash,
  computeSnapshotSha256,
  evaluateB0TimestampStatus,
  evaluateB1UntypedSuspectGraph,
  evaluateB2CompetentVersionAndEnvelope,
  invertChangeOperations,
  qty,
  verifyEngineeringChange,
  type LiveJiraIssueProjection
} from "../src/core/index";
import {
  buildCE01NoApprovedRule,
  buildCE02CoupledUnlistedSlot,
  buildCE03NegatedMissingAttribute,
  buildCE04UnitMismatch,
  buildCE05UpperEnvelopeShift,
  buildCE06DiamondPlacement,
  buildCE07OverlappingEffectivity,
  buildCE08DriftedJiraEvidence,
  buildCE09IncompleteEvidenceFootprint,
  buildCE10UnexaminedNewBomSlot,
  buildCE11aSameRevColdSoakRegression,
  buildCE11bUnexaminedEnvironmentalAxis,
  buildLabeledBenchmarkCorpus
} from "../src/scenarios/counterexamples";
import {
  HELIOS_BASE_EPOCH_MS,
  buildHeliosCapRevCSubstitution,
  createHeliosLiveIssues,
  createHeliosTrustedRoles,
  createHeliosVerificationInput
} from "../src/scenarios/heliosBatteryPack";
import {
  AuthorizationError,
  ConcurrentModificationError,
  ForgeSqlCasStore,
  LineLockService,
  ProvisioningNotReadyError,
  SimulatedTiDbSqlClient,
  SqlProvisioningManager,
  StaleGenerationError,
  StaleSnapshotError,
  type ConnectivityProbeResult,
  type JiraPlatformGateway,
  type MigrationRunnerLike
} from "../src/forge/index";

const require = createRequire(import.meta.url);
const { MigrationRunner: SdkMigrationRunner } = require("@forge/sql/out/migration.js") as {
  MigrationRunner: new (client: unknown) => MigrationRunnerLike;
};

class InMemoryJiraGatewayStub implements JiraPlatformGateway {
  public readonly issuesById = new Map<string, LiveJiraIssueProjection>();
  public rolesByProject = new Map<string, Record<string, readonly string[]>>();

  constructor() {
    const heliosIssues = createHeliosLiveIssues();
    for (const [id, issue] of Object.entries(heliosIssues)) {
      this.issuesById.set(id, issue);
    }
    this.issuesById.set("20204", {
      issueId: "20204",
      issueKey: "ECO-204",
      summary: "Substitute CAP-1210@C from Serial 5000",
      description: "Serial-scoped capacitor substitution due to supplier lead time.",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      structuredFields: {}
    });
    this.rolesByProject.set("ECO", createHeliosTrustedRoles());
  }

  public setIssueStatusCategory(issueId: string, statusCategoryKey: string): void {
    const existing = this.issuesById.get(issueId);
    if (!existing) throw new Error(`Missing stub issue ${issueId}`);
    this.issuesById.set(issueId, {
      ...existing,
      statusCategoryKey,
      updatedAtEpochMs: existing.updatedAtEpochMs + 1_000
    });
  }

  public mutateEvidenceSummary(issueId: string, newSummary: string): void {
    const existing = this.issuesById.get(issueId);
    if (!existing) throw new Error(`Missing stub issue ${issueId}`);
    this.issuesById.set(issueId, {
      ...existing,
      summary: newSummary,
      updatedAtEpochMs: existing.updatedAtEpochMs + 5_000
    });
  }

  public async fetchLiveIssue(issueId: string): Promise<LiveJiraIssueProjection> {
    const found = this.issuesById.get(issueId);
    if (!found) {
      throw new Error(`Jira 404: Issue "${issueId}" not found`);
    }
    return found;
  }

  public async fetchLiveIssueByKeyOrId(
    issueKeyOrId: string
  ): Promise<LiveJiraIssueProjection & { readonly projectKey: string }> {
    const direct = this.issuesById.get(issueKeyOrId);
    if (direct) {
      return { ...direct, projectKey: direct.issueKey.split("-")[0] ?? "ECO" };
    }
    for (const item of this.issuesById.values()) {
      if (item.issueKey.toUpperCase() === issueKeyOrId.toUpperCase()) {
        return { ...item, projectKey: item.issueKey.split("-")[0] ?? "ECO" };
      }
    }
    throw new Error(`Jira 404: Issue "${issueKeyOrId}" not found`);
  }

  public async provisionVerificationIssues() {
    return [];
  }

  public async fetchProjectRoleMembers(
    projectKey: string,
    requiredRoles: readonly string[]
  ): Promise<Record<string, readonly string[]>> {
    const roleMap = this.rolesByProject.get(projectKey) ?? {};
    const out: Record<string, readonly string[]> = {};
    for (const r of requiredRoles) {
      out[r] = roleMap[r] ?? [];
    }
    return out;
  }

  public async probeConnectivity(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<ConnectivityProbeResult> {
    const issue = await this.fetchLiveIssue(params.issueId);
    const roles = this.rolesByProject.get(params.projectKey) ?? {};
    return {
      ok: true,
      checkedAtEpochMs: HELIOS_BASE_EPOCH_MS,
      callerAccountId: "acct-eco-author",
      callerDisplayName: "ECO Author",
      jiraServerBaseUrl: "https://example-industrial.atlassian.net",
      jiraDeploymentType: "Cloud",
      issueReachable: Boolean(issue),
      resolvedRoleCount: Object.keys(roles).length,
      diagnostics: ["stub connectivity ok"]
    };
  }
}

function createTestHarness(options?: { readonly clusterEnabled?: boolean }) {
  let clockMs = HELIOS_BASE_EPOCH_MS;
  const sqlClient = new SimulatedTiDbSqlClient({
    clusterEnabled: options?.clusterEnabled ?? true
  });
  const sdkRunner = new SdkMigrationRunner(sqlClient);
  const provisioning = new SqlProvisioningManager({
    sqlClient,
    migrationRunner: sdkRunner,
    now: () => clockMs
  });
  const store = new ForgeSqlCasStore(sqlClient);
  const jira = new InMemoryJiraGatewayStub();
  const service = new LineLockService({
    store,
    jira,
    provisioning,
    now: () => clockMs,
    intentTtlMs: 60_000
  });

  const advanceClockMs = (deltaMs: number): void => {
    clockMs += deltaMs;
  };

  return { sqlClient, sdkRunner, provisioning, store, jira, service, advanceClockMs };
}

describe("LineLock Vertical Slice — Core Engine, Adversarial Counterexamples & Forge Consistency", () => {
  it("T00: enforces strict pure-kernel trust boundary (zero @forge/* or network imports in src/core)", () => {
    const coreDir = join(process.cwd(), "src", "core");
    const files = readdirSync(coreDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const source = readFileSync(join(coreDir, file), "utf8");
      expect(source).not.toMatch(/@forge\//);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/Date\.now\s*\(/);
    }
  });

  it("T01-T04: verifies Helios EV battery pack serial-scoped substitution, counterfactual 400V-only split, and exact bounded remediation", () => {
    // Baseline: all 6 slice-obligations SUPPORTED_AS_TESTED, awaiting human signoff
    const baselineInput = createHeliosVerificationInput([]);
    const baselineEval = verifyEngineeringChange(baselineInput);
    expect(baselineEval.gateState).toBe("AWAITING_ATTESTATION");
    expect(baselineEval.sliceObligations.every((s) => s.status === "SUPPORTED_AS_TESTED")).toBe(
      true
    );

    // Propose CAP-1210@B -> CAP-1210@C on ALL variants for serial >= 5000
    const allVariantOps = buildHeliosCapRevCSubstitution(baselineInput.catalog, "ALL", 5000);
    const allVariantEval = verifyEngineeringChange({
      ...baselineInput,
      proposedOperations: allVariantOps
    });

    expect(allVariantEval.gateState).toBe("BLOCKED_INVALIDATED");
    expect(allVariantEval.slices.map((s) => s.sliceId)).toEqual([
      "VAR_400V@1000..5000",
      "VAR_400V@5000..INF",
      "VAR_800V@1000..5000",
      "VAR_800V@5000..INF"
    ]);

    const s400Pre = allVariantEval.sliceObligations.find(
      (s) => s.sliceId === "VAR_400V@1000..5000" && s.obligationId === "OBL_THERM_RIPPLE"
    );
    const s400Post = allVariantEval.sliceObligations.find(
      (s) => s.sliceId === "VAR_400V@5000..INF" && s.obligationId === "OBL_THERM_RIPPLE"
    );
    const s800Pre = allVariantEval.sliceObligations.find(
      (s) => s.sliceId === "VAR_800V@1000..5000" && s.obligationId === "OBL_THERM_RIPPLE"
    );
    const s800Post = allVariantEval.sliceObligations.find(
      (s) => s.sliceId === "VAR_800V@5000..INF" && s.obligationId === "OBL_THERM_RIPPLE"
    );

    expect(s400Pre?.status).toBe("SUPPORTED_AS_TESTED");
    expect(s400Post?.status).toBe("SUPPORTED_BY_APPROVED_RULE");
    expect(s400Post?.appliedCarryForwardRuleId).toBe("CFR-400-CAP-SUB");
    expect(s400Post?.requiresDispositionSignoff).toBe(true);

    expect(s800Pre?.status).toBe("SUPPORTED_AS_TESTED");
    // 1.25 * 800V = 1000V > 630V rated_voltage AND dielectric X7R != C0G
    expect(s800Post?.status).toBe("INVALIDATED_PREDICATE_FALSE");

    expect(allVariantEval.remediationPlans).toHaveLength(1);
    expect(allVariantEval.remediationPlans[0]?.solverMode).toBe("EXACT_BOUNDED");
    expect(allVariantEval.remediationPlans[0]?.selectedActions).toHaveLength(1);
    expect(allVariantEval.remediationPlans[0]?.selectedActions[0]?.targetVariantId).toBe(
      "VAR_800V"
    );

    // Counterfactual: restrict Rev C substitution to VAR_400V only for SN >= 5000
    const only400Ops = buildHeliosCapRevCSubstitution(baselineInput.catalog, ["VAR_400V"], 5000);
    const only400Eval = verifyEngineeringChange({
      ...baselineInput,
      proposedOperations: only400Ops
    });
    expect(only400Eval.gateState).toBe("AWAITING_ATTESTATION");
    expect(only400Eval.attestationSummary.requiredRoles).toContain(
      "Power Electronics Disposition Authority"
    );
  });

  it("Issue #1 (CE-09, CE-10, SC-16): enforces closed-world evidence footprint & dependency partition completeness", () => {
    // CE-09: Partial testedSlotBinding omits governed slot HV_INV/GATE_DRIVER_U3
    const ce09Eval = verifyEngineeringChange(buildCE09IncompleteEvidenceFootprint());
    expect(ce09Eval.gateState).toBe("BLOCKED_INDETERMINATE");
    const ce09Ripple = ce09Eval.sliceObligations.find(
      (s) => s.variantId === "VAR_400V" && s.obligationId === "OBL_THERM_RIPPLE"
    );
    expect(ce09Ripple?.status).toBe("INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT");

    // CE-10: ECO adds a brand-new leaf BOM slot HV_INV/SNUBBER_R9 neither governed nor excluded
    const ce10Eval = verifyEngineeringChange(buildCE10UnexaminedNewBomSlot());
    expect(ce10Eval.gateState).toBe("BLOCKED_INDETERMINATE");
    const ce10Post = ce10Eval.sliceObligations.find(
      (s) => s.sliceId === "VAR_400V@5000..INF" && s.obligationId === "OBL_THERM_RIPPLE"
    );
    const ce10Pre = ce10Eval.sliceObligations.find(
      (s) => s.sliceId === "VAR_400V@1000..5000" && s.obligationId === "OBL_THERM_RIPPLE"
    );
    expect(ce10Pre?.status).toBe("SUPPORTED_AS_TESTED");
    expect(ce10Post?.status).toBe("INDETERMINATE_UNEXAMINED_DEPENDENCY");

    // SC-16: Changing an explicitly excluded slot (ENCLOSURE_SEAL_S1) preserves electrical support
    // while invalidating OBL_INGRESS where ENCLOSURE_SEAL_S1 IS governed
    const suite = buildLabeledBenchmarkCorpus();
    const sc16 = suite.find((s) => s.scenarioId === "SC-16")!;
    const sc16Eval = verifyEngineeringChange(sc16.input);
    const ripple3000 = sc16Eval.sliceObligations.find(
      (s) => s.sliceId === "VAR_400V@3000..INF" && s.obligationId === "OBL_THERM_RIPPLE"
    );
    const ingress3000 = sc16Eval.sliceObligations.find(
      (s) => s.sliceId === "VAR_400V@3000..INF" && s.obligationId === "OBL_INGRESS"
    );
    expect(ripple3000?.status).toBe("SUPPORTED_AS_TESTED");
    expect(ripple3000?.changedExcludedSlots).toEqual(["ENCLOSURE_SEAL_S1"]);
    expect(ingress3000?.status).toBe("INVALIDATED_RETEST_REQUIRED");
  });

  it("Adversarial Counterexamples CE-01 through CE-08: falsifies naive carry-forward, K3 negation, unit mismatch, structural overlap, and Jira drift", () => {
    expect(verifyEngineeringChange(buildCE01NoApprovedRule()).gateState).toBe("EVIDENCE_INCOMPLETE");
    expect(verifyEngineeringChange(buildCE02CoupledUnlistedSlot()).gateState).toBe(
      "BLOCKED_INVALIDATED"
    );

    const ce03 = verifyEngineeringChange(buildCE03NegatedMissingAttribute());
    expect(ce03.gateState).toBe("BLOCKED_INDETERMINATE");
    expect(
      ce03.sliceObligations.find(
        (s) => s.sliceId === "VAR_400V@5000..INF" && s.obligationId === "OBL_THERM_RIPPLE"
      )?.validityTrace?.value
    ).toBe("UNKNOWN");

    const ce04 = verifyEngineeringChange(buildCE04UnitMismatch());
    expect(ce04.gateState).toBe("BLOCKED_INDETERMINATE");

    const ce05 = verifyEngineeringChange(buildCE05UpperEnvelopeShift());
    expect(ce05.gateState).toBe("BLOCKED_INVALIDATED");

    const ce06 = verifyEngineeringChange(buildCE06DiamondPlacement());
    expect(
      ce06.sliceObligations.find(
        (s) => s.sliceId === "VAR_800V@5000..INF" && s.obligationId === "OBL_AUX_EMC"
      )?.status
    ).toBe("SUPPORTED_BY_APPROVED_RULE");
    expect(
      ce06.sliceObligations.find(
        (s) => s.sliceId === "VAR_800V@5000..INF" && s.obligationId === "OBL_THERM_RIPPLE"
      )?.status
    ).toBe("INVALIDATED_PREDICATE_FALSE");

    expect(verifyEngineeringChange(buildCE07OverlappingEffectivity()).gateState).toBe(
      "BLOCKED_STRUCTURAL"
    );

    const ce08 = verifyEngineeringChange(buildCE08DriftedJiraEvidence());
    expect(ce08.gateState).toBe("BLOCKED_INVALIDATED");
    expect(
      ce08.sliceObligations.find(
        (s) => s.variantId === "VAR_800V" && s.obligationId === "OBL_THERM_RIPPLE"
      )?.status
    ).toBe("INVALIDATED_EVIDENCE_DRIFT");
  });

  it("Issues #5 & #6 (CE-11a, CE-11b, SC-15 + Benchmark): handles same-part new environmental conditions and beats strengthened B2", () => {
    // CE-11a: Same part revision, cold-soak min_ambient lowered from -20C to -40C
    const ce11aInput = buildCE11aSameRevColdSoakRegression();
    const ce11aLL = verifyEngineeringChange(ce11aInput);
    const ce11aB2 = evaluateB2CompetentVersionAndEnvelope(ce11aInput);

    expect(ce11aLL.gateState).toBe("BLOCKED_INVALIDATED");
    expect(
      ce11aLL.sliceObligations.find(
        (s) => s.variantId === "VAR_400V" && s.obligationId === "OBL_THERM_RIPPLE"
      )?.status
    ).toBe("INVALIDATED_ENVELOPE_EXCEEDED");
    // Strengthened B2 checks -40 <= -20 and FALSELY reports SUPPORTED!
    expect(
      ce11aB2.find((r) => r.variantId === "VAR_400V" && r.obligationId === "OBL_THERM_RIPPLE")
        ?.verdict
    ).toBe("SUPPORTED");

    // CE-11b: Same part revision, new salt_fog_exposure axis added to variant envelope
    const ce11bInput = buildCE11bUnexaminedEnvironmentalAxis();
    const ce11bLL = verifyEngineeringChange(ce11bInput);
    const ce11bB2 = evaluateB2CompetentVersionAndEnvelope(ce11bInput);
    expect(ce11bLL.gateState).toBe("BLOCKED_INDETERMINATE");
    expect(
      ce11bLL.sliceObligations.find(
        (s) => s.variantId === "VAR_400V" && s.obligationId === "OBL_THERM_RIPPLE"
      )?.status
    ).toBe("INDETERMINATE_UNEXAMINED_OPERATING_CONDITION");
    expect(
      ce11bB2.find((r) => r.variantId === "VAR_400V" && r.obligationId === "OBL_THERM_RIPPLE")
        ?.verdict
    ).toBe("SUPPORTED");

    // Full 16-scenario ground-truth verification against B0, B1, and strengthened B2
    const suite = buildLabeledBenchmarkCorpus();
    let llFalseSafe = 0;
    let llFalseBlock = 0;
    let b2FalseSafe = 0;
    let b2FalseBlock = 0;

    for (const sc of suite) {
      const resLL = verifyEngineeringChange(sc.input);
      const resB0 = evaluateB0TimestampStatus(sc.input);
      const resB1 = evaluateB1UntypedSuspectGraph(sc.input);
      const resB2 = evaluateB2CompetentVersionAndEnvelope(sc.input);
      expect(resB0.length).toBeGreaterThan(0);
      expect(resB1.length).toBeGreaterThan(0);

      for (const [key, expected] of Object.entries(sc.expectedSliceObligationSupported)) {
        const [sliceId, obligationId] = key.split("::");
        const mLL = resLL.sliceObligations.find(
          (r) => r.sliceId === sliceId && r.obligationId === obligationId
        )!;
        const mB2 = resB2.find((r) => r.sliceId === sliceId && r.obligationId === obligationId)!;

        const llSupported =
          mLL.status === "SUPPORTED_AS_TESTED" || mLL.status === "SUPPORTED_BY_APPROVED_RULE";
        const b2Supported = mB2.verdict === "SUPPORTED";

        if (!expected && llSupported) llFalseSafe++;
        if (expected && !llSupported) llFalseBlock++;
        if (!expected && b2Supported) b2FalseSafe++;
        if (expected && !b2Supported) b2FalseBlock++;
      }
    }

    expect(llFalseSafe).toBe(0);
    expect(llFalseBlock).toBe(0);
    expect(b2FalseSafe).toBe(6);
    expect(b2FalseBlock).toBe(4);
  });

  it("Issue #2 (ABA H1 -> H2 -> H1 State Restoration): invalidates generation-1 attestations even when SHA-256 returns identically to H1", async () => {
    const { service } = createTestHarness();

    await service.seedReferenceWorkspace({
      ecoIssueId: "20204",
      ecoIssueKey: "ECO-204",
      callerAccountId: "acct-eco-author"
    });

    // State 1 (Generation 1, digest H1): Sign both required roles
    const initialView = await service.getWorkspaceView({ projectKey: "ECO", ecoIssueId: "20204" });
    const h1 = initialView.evaluation!.snapshotSha256;
    expect(initialView.workspace!.eco.approvalGeneration).toBe(1);

    const afterLead = await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: initialView.workspace!.revisionSeq,
      expectedSnapshotSha256: h1,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-lead-eng-1",
      roleName: "Lead Engineers",
      rationale: "Approved baseline release at generation 1."
    });

    const afterQa = await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: afterLead.workspace.revisionSeq,
      expectedSnapshotSha256: h1,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-qa-approver-1",
      roleName: "Quality Approvers",
      rationale: "QA verified baseline evidence at generation 1."
    });

    expect(afterQa.evaluation.gateState).toBe("READY_FOR_RELEASE_TRANSITION");

    // Step H1 -> H2 (Generation 2): Apply 400V-only Cap Rev C substitution
    const opsH2 = buildHeliosCapRevCSubstitution(afterQa.workspace.catalog, ["VAR_400V"], 5000);
    const atH2 = await service.commitProposalOperations({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: afterQa.workspace.revisionSeq,
      callerAccountId: "acct-eco-author",
      proposedOperations: opsH2
    });

    const h2 = atH2.evaluation.snapshotSha256;
    expect(h2).not.toBe(h1);
    expect(atH2.workspace.eco.approvalGeneration).toBe(2);
    expect(atH2.evaluation.gateState).toBe("AWAITING_ATTESTATION");

    // Step H2 -> H1 (Generation 3): Restore exact baseline BOM using inverse operations AND verify digest == H1!
    const inverseToBaseline = invertChangeOperations(afterQa.workspace.catalog, [], opsH2);
    const restoredDigestViaInverse = computeSnapshotSha256({
      catalog: afterQa.workspace.catalog,
      eco: afterQa.workspace.eco,
      proposedOperations: [...opsH2, ...inverseToBaseline],
      liveVerificationIssuesById: createHeliosLiveIssues()
    });
    expect(restoredDigestViaInverse).toBe(h1);

    const restoredAtGen3 = await service.commitProposalOperations({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: atH2.workspace.revisionSeq,
      callerAccountId: "acct-eco-author",
      proposedOperations: []
    });

    // Content digest is IDENTICAL to H1, yet approvalGeneration == 3 invalidates gen-1 attestations!
    expect(restoredAtGen3.evaluation.snapshotSha256).toBe(h1);
    expect(restoredAtGen3.workspace.eco.approvalGeneration).toBe(3);
    expect(restoredAtGen3.evaluation.gateState).toBe("AWAITING_ATTESTATION");
    expect(restoredAtGen3.evaluation.transitionAllowed).toBe(false);
    expect(
      restoredAtGen3.evaluation.attestationSummary.rejectedReasons.every((r) =>
        r.reason.includes("ABA / approval-generation mismatch")
      )
    ).toBe(true);

    // Workflow validator MUST block transition until human signers re-attest generation 3
    const validatorBlocked = await service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "20204",
      actorAccountId: "acct-eco-author"
    });
    expect(validatorBlocked.result).toBe(false);
    expect(validatorBlocked.errorMessage).toContain("gen 3");

    // Stale client attempting to sign against old generation 1 is rejected with StaleGenerationError
    await expect(
      service.recordHumanAttestation({
        projectKey: "ECO",
        ecoIssueId: "20204",
        expectedRevisionSeq: restoredAtGen3.workspace.revisionSeq,
        expectedSnapshotSha256: h1,
        expectedApprovalGeneration: 1,
        signerAccountId: "acct-lead-eng-1",
        roleName: "Lead Engineers",
        rationale: "Stale replay attempt"
      })
    ).rejects.toBeInstanceOf(StaleGenerationError);
  });

  it("Issue #3 (EXP-WF-01..05 Workflow Validation Experiment): proves two-phase PendingTransitionIntent, aborted transition safety, bypass detection, and residual TOCTOU race detection", async () => {
    // --- EXP-WF-01 & EXP-WF-03: Validator writes PendingTransitionIntent ONLY; aborted transition never finalizes ---
    const h = createTestHarness();
    await h.service.seedReferenceWorkspace({
      ecoIssueId: "20204",
      ecoIssueKey: "ECO-204",
      callerAccountId: "acct-eco-author"
    });
    const v0 = await h.service.getWorkspaceView({ projectKey: "ECO", ecoIssueId: "20204" });
    const h1 = v0.evaluation!.snapshotSha256;

    const s1 = await h.service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: v0.workspace!.revisionSeq,
      expectedSnapshotSha256: h1,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-lead-eng-1",
      roleName: "Lead Engineers",
      rationale: "Lead signoff"
    });
    await h.service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: s1.workspace.revisionSeq,
      expectedSnapshotSha256: h1,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-qa-approver-1",
      roleName: "Quality Approvers",
      rationale: "QA signoff"
    });

    // Phase 1: Validator runs BEFORE Jira commits transition
    const valPass = await h.service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "20204",
      actorAccountId: "acct-eco-author"
    });
    expect(valPass.result).toBe(true);

    // EXP-WF-03: Suppose Jira aborts the transition downstream (ECO remains 'indeterminate')!
    const afterValidatorBeforeCommit = await h.service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "20204"
    });
    expect(afterValidatorBeforeCommit.workspace!.pendingTransitionIntent).not.toBeNull();
    expect(afterValidatorBeforeCommit.workspace!.finalizedReleaseReceipt).toBeNull();
    // Crucial: NOT falsely marked RELEASE_TRANSITIONED_VERIFIED!
    expect(afterValidatorBeforeCommit.evaluation!.gateState).toBe("READY_FOR_RELEASE_TRANSITION");

    // Advance past intent TTL (60s) while ECO is still not Done -> expired intent cleaned up
    h.advanceClockMs(65_000);
    await h.service.reconcileIssueUpdatedEvent({ projectKey: "ECO", updatedIssueId: "20204" });
    const afterAbortCleanup = await h.service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "20204"
    });
    expect(afterAbortCleanup.workspace!.pendingTransitionIntent).toBeNull();
    expect(afterAbortCleanup.workspace!.finalizedReleaseReceipt).toBeNull();

    // EXP-WF-01: Re-run validator, then Jira commits Done within TTL -> promoted to FinalizedReleaseReceipt
    const valPass2 = await h.service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "20204",
      actorAccountId: "acct-eco-author"
    });
    expect(valPass2.result).toBe(true);
    h.jira.setIssueStatusCategory("20204", "done");
    const reconciledOk = await h.service.reconcileIssueUpdatedEvent({
      projectKey: "ECO",
      updatedIssueId: "20204"
    });
    expect(reconciledOk?.gateState).toBe("RELEASE_TRANSITIONED_VERIFIED");

    // --- EXP-WF-04: Unprotected Jira workflow route bypasses validator -> caught as UNVALIDATED_RELEASE_DRIFT ---
    const hBypass = createTestHarness();
    await hBypass.service.seedReferenceWorkspace({
      ecoIssueId: "20204",
      ecoIssueKey: "ECO-204",
      callerAccountId: "acct-eco-author"
    });
    hBypass.jira.setIssueStatusCategory("20204", "done");
    const bypassEval = await hBypass.service.reconcileIssueUpdatedEvent({
      projectKey: "ECO",
      updatedIssueId: "20204"
    });
    expect(bypassEval?.gateState).toBe("UNVALIDATED_RELEASE_DRIFT");
    expect(bypassEval?.transitionAllowed).toBe(false);

    // --- EXP-WF-05: Residual [t_validator, t_jira_commit] TOCTOU concurrency race ---
    // Validator returns { result: true } at t1, then linked Jira test evidence VER-101 is edited at t2
    // BEFORE Jira finishes committing Done at t3. Jira commits Done, and Phase 2 deterministically flags drift!
    const hToctou = createTestHarness();
    await hToctou.service.seedReferenceWorkspace({
      ecoIssueId: "20204",
      ecoIssueKey: "ECO-204",
      callerAccountId: "acct-eco-author"
    });
    const vt0 = await hToctou.service.getWorkspaceView({ projectKey: "ECO", ecoIssueId: "20204" });
    const digestT0 = vt0.evaluation!.snapshotSha256;
    const vt1 = await hToctou.service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: vt0.workspace!.revisionSeq,
      expectedSnapshotSha256: digestT0,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-lead-eng-1",
      roleName: "Lead Engineers",
      rationale: "Lead ok"
    });
    await hToctou.service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: vt1.workspace.revisionSeq,
      expectedSnapshotSha256: digestT0,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-qa-approver-1",
      roleName: "Quality Approvers",
      rationale: "QA ok"
    });

    // t1: Validator passes and writes PendingTransitionIntent for digestT0
    const preCommitValidator = await hToctou.service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "20204",
      actorAccountId: "acct-eco-author"
    });
    expect(preCommitValidator.result).toBe(true);

    // t2: Concurrent mutation to linked verification issue VER-101 inside TOCTOU window!
    hToctou.jira.mutateEvidenceSummary("10101", "TAMPERED IN-FLIGHT TEST SUMMARY");

    // t3: Jira still commits Done (since validator already returned true at t1)
    hToctou.jira.setIssueStatusCategory("20204", "done");

    // t4: Phase-2 trigger reconciles and catches the TOCTOU drift deterministically
    const toctouReconciled = await hToctou.service.reconcileIssueUpdatedEvent({
      projectKey: "ECO",
      updatedIssueId: "20204"
    });
    expect(toctouReconciled?.gateState).toBe("UNVALIDATED_RELEASE_DRIFT");
    const afterToctouView = await hToctou.service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "20204"
    });
    expect(afterToctouView.workspace?.finalizedReleaseReceipt).toBeNull();
    expect(afterToctouView.workspace?.unvalidatedDriftDetected).toBe(true);
  });

  it("Issue #4: verifies @forge/kvs lacks plain conditional CAS while ForgeSqlCasStore enforces atomic affectedRows CAS and rejects DML DDL", async () => {
    // 1. Verify @forge/kvs TransactionBuilderImpl behavior directly against installed SDK
    const { TransactionBuilderImpl } = require("@forge/kvs/out/transaction-api.js") as {
      TransactionBuilderImpl: new (storageApi: {
        transact: (req: { set?: Record<string, unknown>[]; check?: unknown }) => Promise<void>;
      }) => {
        set: (key: string, value: unknown) => { execute: () => Promise<void> };
        check: (key: string, entity?: unknown) => unknown;
      };
    };
    let capturedTransactPayload: { set?: Record<string, unknown>[]; check?: unknown } | null = null;
    const kvsBuilder = new TransactionBuilderImpl({
      transact: async (req) => {
        capturedTransactPayload = req;
      }
    });
    await kvsBuilder.set("eco:20204", { rev: 1 }).execute();
    expect(capturedTransactPayload).not.toBeNull();
    expect(capturedTransactPayload!.check).toBeUndefined();
    expect(capturedTransactPayload!.set?.[0]?.["conditions"]).toBeUndefined();
    // Calling .check() without a Custom Entity throws TypeError
    expect(() => kvsBuilder.check("eco:20204", undefined)).toThrow(TypeError);

    // 2. Verify Forge SQL DML endpoint (/api/v1/execute) rejects DDL (CREATE TABLE)
    const { sqlClient, provisioning, service } = createTestHarness();
    await expect(
      sqlClient.prepare("CREATE TABLE illegal_dml_ddl (id INT PRIMARY KEY)").execute()
    ).rejects.toThrow(ForgeSQLAPIError);

    // 3. Provision tables via MigrationRunner (/api/v1/execute/ddl) and run concurrent CAS race
    const provStatus = await provisioning.runMigrations("test-cas");
    expect(provStatus.state).toBe("READY");

    const seeded = await service.seedReferenceWorkspace({
      ecoIssueId: "20204",
      ecoIssueKey: "ECO-204",
      callerAccountId: "acct-eco-author"
    });
    expect(seeded.revisionSeq).toBe(1);

    const view = await service.getWorkspaceView({ projectKey: "ECO", ecoIssueId: "20204" });
    const h1 = view.evaluation!.snapshotSha256;

    // Two signers concurrently attempt CAS against expectedRevisionSeq = 1
    const [resA, resB] = await Promise.allSettled([
      service.recordHumanAttestation({
        projectKey: "ECO",
        ecoIssueId: "20204",
        expectedRevisionSeq: 1,
        expectedSnapshotSha256: h1,
        expectedApprovalGeneration: 1,
        signerAccountId: "acct-lead-eng-1",
        roleName: "Lead Engineers",
        rationale: "Concurrent signer A"
      }),
      service.recordHumanAttestation({
        projectKey: "ECO",
        ecoIssueId: "20204",
        expectedRevisionSeq: 1,
        expectedSnapshotSha256: h1,
        expectedApprovalGeneration: 1,
        signerAccountId: "acct-qa-approver-1",
        roleName: "Quality Approvers",
        rationale: "Concurrent signer B"
      })
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConcurrentModificationError);

    const storedAfterRace = await service.getWorkspaceView({
      projectKey: "ECO",
      ecoIssueId: "20204"
    });
    expect(storedAfterRace.workspace?.revisionSeq).toBe(2);
    expect(storedAfterRace.workspace?.attestations).toHaveLength(1);
  });

  it("Issue #7: handles async Forge SQL cluster APP_NOT_ENABLED, partial DDL migration failure, and idempotent installation recovery", async () => {
    // Start with clusterEnabled = false (cold Forge SQL TiDB cluster still provisioning)
    const { sqlClient, provisioning, service } = createTestHarness({ clusterEnabled: false });

    const coldStatus = await provisioning.inspectStatus();
    expect(coldStatus.state).toBe("PROVISIONING_IN_PROGRESS");
    expect(coldStatus.lastErrorCode).toBe(errorCodes.APP_NOT_ENABLED);

    // Workflow validator MUST fail closed while provisioning is in progress
    const blockedDuringColdInstall = await service.validateReleaseTransition({
      projectKey: "ECO",
      ecoIssueId: "20204",
      actorAccountId: "acct-eco-author"
    });
    expect(blockedDuringColdInstall.result).toBe(false);
    expect(blockedDuringColdInstall.errorMessage).toContain("PROVISIONING_IN_PROGRESS");

    // Mutating operations throw ProvisioningNotReadyError cleanly
    await expect(
      service.seedReferenceWorkspace({
        ecoIssueId: "20204",
        ecoIssueKey: "ECO-204",
        callerAccountId: "acct-eco-author"
      })
    ).rejects.toBeInstanceOf(ProvisioningNotReadyError);

    // TiDB cluster finishes provisioning, but migration v002 fails transiently
    sqlClient.clusterEnabled = true;
    sqlClient.failDdlMatchingSubstring = "linelock_provisioning_audit";

    const failedRun = await provisioning.runMigrations("avi:forge:installed:app");
    expect(failedRun.state).toBe("PROVISIONING_FAILED");
    expect(failedRun.appliedMigrations).toEqual(["v001_create_linelock_eco_workspaces"]);
    expect(failedRun.pendingMigrations).toEqual(["v002_create_linelock_provisioning_audit"]);

    // Clear transient DDL failure and run idempotent recovery -> skips v001, applies v002 -> READY
    sqlClient.failDdlMatchingSubstring = null;
    const recovered = await service.triggerProvisioningRecovery("manual-recovery");
    expect(recovered.state).toBe("READY");
    expect(recovered.appliedMigrations).toEqual([
      "v001_create_linelock_eco_workspaces",
      "v002_create_linelock_provisioning_audit"
    ]);
    expect(recovered.pendingMigrations).toEqual([]);

    // Workspace operations now succeed cleanly
    const ws = await service.seedReferenceWorkspace({
      ecoIssueId: "20204",
      ecoIssueKey: "ECO-204",
      callerAccountId: "acct-eco-author"
    });
    expect(ws.revisionSeq).toBe(1);
  });

  it("enforces separation of duties, live role membership, and stale snapshot rejection on human attestations", async () => {
    const { service, jira } = createTestHarness();
    await service.seedReferenceWorkspace({
      ecoIssueId: "20204",
      ecoIssueKey: "ECO-204",
      callerAccountId: "acct-eco-author"
    });
    const v = await service.getWorkspaceView({ projectKey: "ECO", ecoIssueId: "20204" });
    const h1 = v.evaluation!.snapshotSha256;

    // ECO author cannot self-approve even though acct-eco-author is in Lead Engineers
    await expect(
      service.recordHumanAttestation({
        projectKey: "ECO",
        ecoIssueId: "20204",
        expectedRevisionSeq: 1,
        expectedSnapshotSha256: h1,
        expectedApprovalGeneration: 1,
        signerAccountId: "acct-eco-author",
        roleName: "Lead Engineers",
        rationale: "Self-approval attempt"
      })
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Stale snapshot digest rejected with StaleSnapshotError
    await expect(
      service.recordHumanAttestation({
        projectKey: "ECO",
        ecoIssueId: "20204",
        expectedRevisionSeq: 1,
        expectedSnapshotSha256: "0".repeat(64),
        expectedApprovalGeneration: 1,
        signerAccountId: "acct-lead-eng-1",
        roleName: "Lead Engineers",
        rationale: "Wrong snapshot hash"
      })
    ).rejects.toBeInstanceOf(StaleSnapshotError);

    // Dual-hat user signing both roles satisfies at most 1 role under bipartite separation-of-duties
    const dual1 = await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: 1,
      expectedSnapshotSha256: h1,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-multi-role-user",
      roleName: "Lead Engineers",
      rationale: "Dual-hat user signs Lead Engineers"
    });
    const dual2 = await service.recordHumanAttestation({
      projectKey: "ECO",
      ecoIssueId: "20204",
      expectedRevisionSeq: dual1.workspace.revisionSeq,
      expectedSnapshotSha256: h1,
      expectedApprovalGeneration: 1,
      signerAccountId: "acct-multi-role-user",
      roleName: "Quality Approvers",
      rationale: "Same dual-hat user attempts to also satisfy Quality Approvers"
    });
    expect(dual2.evaluation.gateState).toBe("AWAITING_ATTESTATION");
    expect(dual2.evaluation.attestationSummary.satisfiedRoles).toHaveLength(1);
    expect(dual2.evaluation.attestationSummary.missingRoles).toHaveLength(1);

    // Canonical JSON & pinned issue hash determinism check
    const issue = await jira.fetchLiveIssue("10101");
    expect(computePinnedIssueStateHash(issue)).toHaveLength(64);
    expect(canonicalizeJson({ b: qty(10, 1, "V"), a: true })).toBe(
      canonicalizeJson({ a: true, b: qty(10, 1, "V") })
    );
  });
});
