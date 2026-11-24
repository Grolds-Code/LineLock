import { randomUUID } from "node:crypto";
import { buildReleaseAssuranceMarkdown } from "../core/auditPacket";
import {
  evaluateB0TimestampStatus,
  evaluateB1UntypedSuspectGraph,
  evaluateB2CompetentVersionAndEnvelope
} from "../core/baselines";
import { computePinnedIssueStateHash } from "../core/canonical";
import { buildSerialScopedSubstitutionOps } from "../core/intervals";
import {
  enumVal,
  qty,
  type ChangeOperation,
  type EcoMetadata,
  type FamilyCatalog,
  type FinalizedReleaseReceipt,
  type ItemRevision,
  type LiveJiraIssueProjection,
  type PendingTransitionIntent,
  type RoleAttestation,
  type ScalarValue,
  type VerificationEvaluation,
  type VerificationInput,
  type VerificationPolicy
} from "../core/types";
import { verifyEngineeringChange } from "../core/verifier";
import {
  buildHeliosCapRevCSubstitution,
  createHeliosDefaultEco
} from "../scenarios/heliosBatteryPack";
import {
  buildFlagshipSubstitutionForCatalog,
  inferScopedSafeVariantForCatalog,
  instantiateIndustryTemplate,
  type IndustryTemplateId
} from "../scenarios/industryTemplates";
import {
  AuthorizationError,
  ConcurrentModificationError,
  ProvisioningNotReadyError,
  StaleGenerationError,
  StaleSnapshotError,
  type BaselineTotalsSummary,
  type BindJiraEvidenceRequest,
  type ConnectivityProbeResult,
  type CounterfactualRequest,
  type CounterfactualSimulationResult,
  type CustomComponentSubstitutionRequest,
  type EcoWorkspaceView,
  type FleetEcoSummaryRow,
  type GovernancePolicyMode,
  type JiraPlatformGateway,
  type LiveEvidenceIntegrityRow,
  type ProjectFleetOverview,
  type ProvisioningStatusReport,
  type ScenarioPresetId,
  type StoredEcoWorkspace,
  type VerificationIssueSeedSpec,
  type VerificationStore
} from "./ports";
import type { SqlProvisioningManager } from "./provisioning";

export const DEFAULT_PENDING_INTENT_TTL_MS = 120_000;

export interface WorkflowValidatorResponse {
  readonly result: boolean;
  readonly errorMessage?: string;
}

function countSupported(ev: VerificationEvaluation): number {
  return ev.sliceObligations.filter(
    (s) => s.status === "SUPPORTED_AS_TESTED" || s.status === "SUPPORTED_BY_APPROVED_RULE"
  ).length;
}

function countRequiredRetests(ev: VerificationEvaluation): number {
  return ev.remediationPlans.reduce((sum, plan) => sum + plan.selectedActions.length, 0);
}

export class LineLockService {
  private readonly store: VerificationStore;
  private readonly jira: JiraPlatformGateway;
  private readonly provisioning: SqlProvisioningManager;
  private readonly now: () => number;
  private readonly intentTtlMs: number;

  constructor(params: {
    readonly store: VerificationStore;
    readonly jira: JiraPlatformGateway;
    readonly provisioning: SqlProvisioningManager;
    readonly now?: () => number;
    readonly intentTtlMs?: number;
  }) {
    this.store = params.store;
    this.jira = params.jira;
    this.provisioning = params.provisioning;
    this.now = params.now ?? (() => Date.now());
    this.intentTtlMs = params.intentTtlMs ?? DEFAULT_PENDING_INTENT_TTL_MS;
  }

  public async runConnectivityProbe(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<{
    readonly connectivity: ConnectivityProbeResult;
    readonly provisioning: ProvisioningStatusReport;
  }> {
    const [connectivity, provisioning] = await Promise.all([
      this.jira.probeConnectivity(params),
      this.provisioning.inspectStatus()
    ]);
    return { connectivity, provisioning };
  }

  public async triggerProvisioningRecovery(
    triggerSource: string
  ): Promise<ProvisioningStatusReport> {
    return this.provisioning.runMigrations(triggerSource);
  }

  public async getWorkspaceView(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly callerAccountId?: string;
    readonly readOnly?: boolean;
  }): Promise<EcoWorkspaceView> {
    const provisioning = await this.provisioning.inspectStatus();
    if (provisioning.state !== "READY") {
      return {
        callerAccountId: params.callerAccountId,
        provisioning,
        workspace: null,
        evaluation: null,
        evidenceIntegrity: []
      };
    }

    let workspace = await this.store.getEcoWorkspace(params.ecoIssueId);
    if (!workspace) {
      return {
        callerAccountId: params.callerAccountId,
        provisioning,
        workspace: null,
        evaluation: null,
        evidenceIntegrity: []
      };
    }

    if (!params.readOnly) {
      workspace = await this.maybeFinalizePendingTransitionIntent(
        params.projectKey,
        params.ecoIssueId,
        workspace
      );
    }

    const { evaluation, evidenceIntegrity, baselineSummary } =
      await this.evaluateWorkspaceWithIntegrity(
        params.projectKey,
        workspace,
        undefined,
        undefined,
        params.callerAccountId
      );
    const releaseAssuranceMarkdown = buildReleaseAssuranceMarkdown({
      catalog: workspace.catalog,
      eco: workspace.eco,
      evaluation,
      finalizedReceipt: workspace.finalizedReleaseReceipt
    });
    const liveEcoForReconciliation = params.readOnly && workspace.pendingTransitionIntent
      ? await this.jira.fetchLiveIssue(params.ecoIssueId)
      : null;
    const reconciliationStatus =
      liveEcoForReconciliation?.statusCategoryKey.toLowerCase() === "done" &&
      !workspace.finalizedReleaseReceipt
        ? "PENDING_RELEASE_RECONCILIATION" as const
        : undefined;
    return {
      callerAccountId: params.callerAccountId,
      provisioning,
      workspace,
      evaluation,
      evidenceIntegrity,
      releaseAssuranceMarkdown,
      baselineSummary,
      reconciliationStatus
    };
  }

  public async seedReferenceWorkspace(params: {
    readonly ecoIssueId: string;
    readonly ecoIssueKey: string;
    readonly callerAccountId: string;
    readonly templateId?: IndustryTemplateId;
    readonly catalog?: FamilyCatalog;
  }): Promise<StoredEcoWorkspace> {
    await this.ensureProvisionedOrThrow();

    const existing = await this.store.getEcoWorkspace(params.ecoIssueId);
    if (existing) {
      return existing;
    }

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);
    const defaultEco = createHeliosDefaultEco();
    const catalog =
      params.catalog ??
      instantiateIndustryTemplate(params.templateId ?? "AUTOMOTIVE_EV_HELIOS").catalog;

    const eco: EcoMetadata = {
      ...defaultEco,
      ecoJiraIssueId: params.ecoIssueId,
      ecoJiraKey: params.ecoIssueKey || liveEco.issueKey,
      ecoCreatedAtEpochMs: this.now(),
      authorAccountId: params.callerAccountId,
      lastEditorAccountId: params.callerAccountId,
      approvalGeneration: 1,
      liveEcoStatusCategoryKey: liveEco.statusCategoryKey
    };

    return this.store.insertInitialEcoWorkspace({
      ecoIssueId: params.ecoIssueId,
      updatedAtEpochMs: this.now(),
      catalog,
      eco,
      proposedOperations: [],
      attestations: [],
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected: false
    });
  }

  /**
   * Creates 6 real Jira verification work items in `projectKey` (`POST /rest/api/3/issue`),
   * transitions each to Done, links each to `ecoIssueKey`, and pins their real live SHA-256
   * content hashes into the ECO workspace in Forge SQL TiDB (via INSERT or CAS UPDATE).
   * Supports Automotive EV, MedTech Class III IEC 60601, and Aerospace DO-160G templates.
   */
  public async provisionLiveJiraWorkspace(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly ecoIssueKey: string;
    readonly callerAccountId: string;
    readonly templateId?: IndustryTemplateId;
  }): Promise<EcoWorkspaceView> {
    await this.ensureProvisionedOrThrow();

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);
    const resolvedEcoKey = params.ecoIssueKey || liveEco.issueKey;

    const { referenceIssues, catalog: templateCatalog } = instantiateIndustryTemplate(
      params.templateId ?? "AUTOMOTIVE_EV_HELIOS"
    );

    const specs: VerificationIssueSeedSpec[] = templateCatalog.evidenceRecords.map((ev) => {
      const refIssue = referenceIssues[ev.jiraIssueId];
      return {
        evidenceId: ev.evidenceId,
        summary: `[LineLock ${ev.evidenceId}] ${refIssue?.summary ?? ev.obligationId}`,
        description:
          refIssue?.description ??
          `Qualification evidence ${ev.evidenceId} for ${ev.testedVariantId}.`
      };
    });

    const provisionedList = await this.jira.provisionVerificationIssues({
      projectKey: params.projectKey,
      ecoIssueKey: resolvedEcoKey,
      specs,
      onCreatedBeforeTransition: async (createdIds) => {
        if (this.store.registerEvidenceIssueIds) {
          await this.store.registerEvidenceIssueIds(createdIds);
        }
      }
    });

    const provisionedByEvidenceId = new Map(
      provisionedList.map((p) => [p.evidenceId, p.liveIssue])
    );

    const boundEvidence = templateCatalog.evidenceRecords.map((ev) => {
      const liveIssue = provisionedByEvidenceId.get(ev.evidenceId);
      if (!liveIssue) {
        throw new Error(`Missing provisioned Jira issue for evidence "${ev.evidenceId}".`);
      }
      return {
        ...ev,
        jiraIssueId: liveIssue.issueId,
        jiraIssueKey: liveIssue.issueKey,
        pinnedIssueStateHash: computePinnedIssueStateHash(liveIssue)
      };
    });

    const liveCatalog: FamilyCatalog = {
      ...templateCatalog,
      evidenceRecords: boundEvidence
    };

    const existing = await this.store.getEcoWorkspace(params.ecoIssueId);
    const nowMs = this.now();

    if (!existing) {
      const defaultEco = createHeliosDefaultEco();
      await this.store.insertInitialEcoWorkspace({
        ecoIssueId: params.ecoIssueId,
        updatedAtEpochMs: nowMs,
        catalog: liveCatalog,
        eco: {
          ...defaultEco,
          ecoJiraIssueId: params.ecoIssueId,
          ecoJiraKey: resolvedEcoKey,
          ecoCreatedAtEpochMs: nowMs,
          authorAccountId: params.callerAccountId,
          lastEditorAccountId: params.callerAccountId,
          approvalGeneration: 1,
          liveEcoStatusCategoryKey: liveEco.statusCategoryKey
        },
        proposedOperations: [],
        attestations: [],
        pendingTransitionIntent: null,
        finalizedReleaseReceipt: null,
        unvalidatedDriftDetected: false
      });
    } else {
      await this.store.casUpdateEcoWorkspace(existing.revisionSeq, {
        ecoIssueId: existing.ecoIssueId,
        updatedAtEpochMs: nowMs,
        catalog: liveCatalog,
        eco: {
          ...existing.eco,
          ecoJiraKey: resolvedEcoKey,
          lastEditorAccountId: params.callerAccountId,
          approvalGeneration: existing.eco.approvalGeneration + 1,
          liveEcoStatusCategoryKey: liveEco.statusCategoryKey
        },
        proposedOperations: [],
        attestations: [],
        pendingTransitionIntent: null,
        finalizedReleaseReceipt: null,
        unvalidatedDriftDetected: false
      });
    }

    return this.getWorkspaceView({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      callerAccountId: params.callerAccountId
    });
  }

  public async commitProposalOperations(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly expectedRevisionSeq: number;
    readonly callerAccountId: string;
    readonly proposedOperations: readonly ChangeOperation[];
  }): Promise<{
    readonly workspace: StoredEcoWorkspace;
    readonly evaluation: VerificationEvaluation;
  }> {
    await this.ensureProvisionedOrThrow();

    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (ws.revisionSeq !== params.expectedRevisionSeq) {
      throw new ConcurrentModificationError(
        `Stale workspace revisionSeq ${params.expectedRevisionSeq}; stored revisionSeq is ${ws.revisionSeq}.`
      );
    }

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);
    const nextEco: EcoMetadata = {
      ...ws.eco,
      lastEditorAccountId: params.callerAccountId,
      approvalGeneration: ws.eco.approvalGeneration + 1,
      liveEcoStatusCategoryKey: liveEco.statusCategoryKey
    };

    const updated = await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
      ecoIssueId: ws.ecoIssueId,
      updatedAtEpochMs: this.now(),
      catalog: ws.catalog,
      eco: nextEco,
      proposedOperations: params.proposedOperations,
      attestations: ws.attestations,
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected:
        ws.unvalidatedDriftDetected || liveEco.statusCategoryKey.toLowerCase() === "done"
    });

    const evaluation = await this.evaluateWorkspaceAgainstLiveJira(params.projectKey, updated);
    return { workspace: updated, evaluation };
  }

  public async applyScenarioPreset(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly expectedRevisionSeq: number;
    readonly callerAccountId: string;
    readonly presetId: ScenarioPresetId;
  }): Promise<EcoWorkspaceView> {
    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    const ops = this.buildOperationsForPreset(ws.catalog, params.presetId);
    await this.commitProposalOperations({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      expectedRevisionSeq: params.expectedRevisionSeq,
      callerAccountId: params.callerAccountId,
      proposedOperations: ops
    });
    return this.getWorkspaceView({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      callerAccountId: params.callerAccountId
    });
  }

  /**
   * Purely read-only counterfactual simulator: evaluates candidate serial cutovers or
   * operating-envelope changes against live Jira state without mutating Forge SQL.
   */
  public async simulateCounterfactual(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly request: CounterfactualRequest;
    readonly includeBaselines?: boolean;
    readonly readOnly?: boolean;
  }): Promise<CounterfactualSimulationResult> {
    if (params.readOnly) await this.requireAlreadyProvisioned();
    else await this.ensureProvisionedOrThrow();
    const ws = await this.mustLoadWorkspace(params.ecoIssueId);

    const proposedOperations = this.buildOperationsForCounterfactual(ws.catalog, params.request);
    const { liveEco, trustedRoles, liveIssuesById } = await this.fetchLiveVerificationContext(
      params.projectKey,
      ws
    );

    const baseInput: VerificationInput = {
      catalog: ws.catalog,
      eco: {
        ...ws.eco,
        liveEcoStatusCategoryKey: liveEco.statusCategoryKey
      },
      proposedOperations: ws.proposedOperations,
      liveVerificationIssuesById: liveIssuesById,
      attestations: ws.attestations,
      trustedRoleMembersByRole: trustedRoles,
      pendingTransitionIntent: ws.pendingTransitionIntent,
      finalizedReleaseReceipt: ws.finalizedReleaseReceipt,
      unvalidatedDriftDetected: ws.unvalidatedDriftDetected
    };

    const currentEvaluation = verifyEngineeringChange(baseInput);

    const simulatedInput: VerificationInput = {
      ...baseInput,
      eco: {
        ...baseInput.eco,
        approvalGeneration: ws.eco.approvalGeneration + 1
      },
      proposedOperations,
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null
    };

    const simulatedEvaluation = verifyEngineeringChange(simulatedInput);

    const currentSupportedCount = countSupported(currentEvaluation);
    const simulatedSupportedCount = countSupported(simulatedEvaluation);

    return {
      currentEvaluation,
      simulatedEvaluation,
      proposedOperations,
      delta: {
        currentGateState: currentEvaluation.gateState,
        simulatedGateState: simulatedEvaluation.gateState,
        currentSupportedCount,
        simulatedSupportedCount,
        currentBlockedCount:
          currentEvaluation.sliceObligations.length - currentSupportedCount,
        simulatedBlockedCount:
          simulatedEvaluation.sliceObligations.length - simulatedSupportedCount,
        currentRequiredRetests: countRequiredRetests(currentEvaluation),
        simulatedRequiredRetests: countRequiredRetests(simulatedEvaluation)
      },
      baselineComparison: params.includeBaselines
        ? {
            b0: evaluateB0TimestampStatus(simulatedInput),
            b1: evaluateB1UntypedSuspectGraph(simulatedInput),
            b2: evaluateB2CompetentVersionAndEnvelope(simulatedInput)
          }
        : undefined
    };
  }

  /**
   * Switches between Production Multi-Role Separation-of-Duties Policy and Single-Evaluator
   * Demo Policy (`Administrators` role) via an explicit, audited `policyVersion` + `approvalGeneration`
   * CAS increment (never bypassing policy binding or live Jira role verification).
   */
  public async switchGovernancePolicyMode(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly expectedRevisionSeq: number;
    readonly callerAccountId: string;
    readonly mode: GovernancePolicyMode;
  }): Promise<EcoWorkspaceView> {
    await this.ensureProvisionedOrThrow();

    // A viewer must never be able to weaken separation of duties or invalidate signoffs.
    // Resolve group-backed membership for the invoking user against live Jira project roles.
    const roleMembers = await this.jira.fetchProjectRoleMembers(
      params.projectKey,
      ["Administrators"],
      [params.callerAccountId]
    );
    if (!roleMembers["Administrators"]?.includes(params.callerAccountId)) {
      throw new AuthorizationError(
        "Changing governance policy requires membership in the Jira project's Administrators role."
      );
    }

    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (ws.revisionSeq !== params.expectedRevisionSeq) {
      throw new ConcurrentModificationError(
        `Stale workspace revisionSeq ${params.expectedRevisionSeq}; stored revisionSeq is ${ws.revisionSeq}.`
      );
    }

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);
    const nextPolicyVersion = ws.catalog.policy.policyVersion + 1;

    const isMedTech = ws.catalog.familyId.startsWith("PULSEGUARD");
    const isAero = ws.catalog.familyId.startsWith("AEGIS");
    const prodPolicyId = isMedTech
      ? "POL-MEDTECH-60601"
      : isAero
        ? "POL-AERO-DO160G"
        : "POL-HELIOS-2026";
    const soloPolicyId = isMedTech
      ? "POL-MEDTECH-SOLO-EVALUATOR"
      : isAero
        ? "POL-AERO-SOLO-EVALUATOR"
        : "POL-HELIOS-SOLO-EVALUATOR";

    const nextPolicy: VerificationPolicy =
      params.mode === "DEMO_SOLO_ADMIN"
        ? {
            policyId: soloPolicyId,
            policyVersion: nextPolicyVersion,
            requiredAttestationRoles: ["Administrators"],
            carryForwardDispositionRole: "Administrators",
            enforceSeparationOfDuties: false,
            allowRuleBasedCarryForward: true
          }
        : {
            policyId: prodPolicyId,
            policyVersion: nextPolicyVersion,
            requiredAttestationRoles: ["Lead Engineers", "Quality Approvers"],
            carryForwardDispositionRole: isMedTech
              ? "Clinical Risk Disposition Authority"
              : isAero
                ? "Airworthiness Disposition Authority"
                : "Power Electronics Disposition Authority",
            enforceSeparationOfDuties: true,
            allowRuleBasedCarryForward: true
          };

    await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
      ecoIssueId: ws.ecoIssueId,
      updatedAtEpochMs: this.now(),
      catalog: {
        ...ws.catalog,
        policy: nextPolicy
      },
      eco: {
        ...ws.eco,
        lastEditorAccountId: params.callerAccountId,
        approvalGeneration: ws.eco.approvalGeneration + 1,
        liveEcoStatusCategoryKey: liveEco.statusCategoryKey
      },
      proposedOperations: ws.proposedOperations,
      attestations: ws.attestations,
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected:
        ws.unvalidatedDriftDetected || liveEco.statusCategoryKey.toLowerCase() === "done"
    });

    return this.getWorkspaceView({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      callerAccountId: params.callerAccountId
    });
  }

  public async recordHumanAttestation(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly expectedRevisionSeq: number;
    readonly expectedSnapshotSha256: string;
    readonly expectedApprovalGeneration: number;
    readonly signerAccountId: string;
    readonly roleName: string;
    readonly rationale: string;
  }): Promise<{
    readonly workspace: StoredEcoWorkspace;
    readonly evaluation: VerificationEvaluation;
  }> {
    await this.ensureProvisionedOrThrow();

    if (!params.signerAccountId.trim()) {
      throw new AuthorizationError(
        "Authenticated Atlassian accountId is required to sign an attestation."
      );
    }
    if (!params.rationale.trim()) {
      throw new AuthorizationError(
        "Non-empty engineering rationale is required for role attestation."
      );
    }

    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (ws.revisionSeq !== params.expectedRevisionSeq) {
      throw new ConcurrentModificationError(
        `Stale workspace revisionSeq ${params.expectedRevisionSeq}; stored revisionSeq is ${ws.revisionSeq}.`
      );
    }

    if (ws.eco.approvalGeneration !== params.expectedApprovalGeneration) {
      throw new StaleGenerationError(
        `Approval generation mismatch: caller attested gen ${params.expectedApprovalGeneration}, live gen is ${ws.eco.approvalGeneration}.`
      );
    }

    const requiredRoles = this.collectAllPossibleRoles(ws.catalog);
    const candidateAccountIds = [
      params.signerAccountId,
      ...ws.attestations.map((a) => a.signerAccountId)
    ];
    const trustedRoles = await this.jira.fetchProjectRoleMembers(
      params.projectKey,
      requiredRoles,
      candidateAccountIds
    );
    const roleMembers = trustedRoles[params.roleName] ?? [];
    if (!roleMembers.includes(params.signerAccountId)) {
      throw new AuthorizationError(
        `Account "${params.signerAccountId}" is not an authorized member of Jira project role "${params.roleName}".`
      );
    }

    if (ws.catalog.policy.enforceSeparationOfDuties) {
      if (params.signerAccountId === ws.eco.authorAccountId) {
        throw new AuthorizationError(
          `Separation-of-duties violation: ECO author "${params.signerAccountId}" cannot sign release attestations.`
        );
      }
      if (params.signerAccountId === ws.eco.lastEditorAccountId) {
        throw new AuthorizationError(
          `Separation-of-duties violation: last proposal editor "${params.signerAccountId}" cannot sign release attestations.`
        );
      }
    }

    const liveEvalBefore = await this.evaluateWorkspaceAgainstLiveJira(
      params.projectKey,
      ws,
      trustedRoles
    );

    if (liveEvalBefore.snapshotSha256 !== params.expectedSnapshotSha256) {
      throw new StaleSnapshotError(
        `Snapshot digest changed before attestation commit: expected ${params.expectedSnapshotSha256.slice(0, 12)}, live is ${liveEvalBefore.snapshotSha256.slice(0, 12)}.`
      );
    }

    const newAttestation: RoleAttestation = {
      attestationId: `att-${randomUUID()}`,
      ecoJiraIssueId: ws.ecoIssueId,
      roleName: params.roleName,
      signerAccountId: params.signerAccountId,
      attestedSnapshotSha256: liveEvalBefore.snapshotSha256,
      attestedApprovalGeneration: ws.eco.approvalGeneration,
      attestedPolicyVersion: ws.catalog.policy.policyVersion,
      rationale: params.rationale.trim(),
      signedAtEpochMs: this.now()
    };

    const updated = await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
      ecoIssueId: ws.ecoIssueId,
      updatedAtEpochMs: this.now(),
      catalog: ws.catalog,
      eco: ws.eco,
      proposedOperations: ws.proposedOperations,
      attestations: [...ws.attestations, newAttestation],
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected: ws.unvalidatedDriftDetected
    });

    const evaluation = await this.evaluateWorkspaceAgainstLiveJira(
      params.projectKey,
      updated,
      trustedRoles
    );
    return { workspace: updated, evaluation };
  }

  /**
   * Re-pins the cryptographic RFC 8785 SHA-256 content hashes of all linked Jira qualification
   * work items after legitimate test updates. Strictly enforces:
   * 1. Every linked Jira qualification work item must be reachable and in Done status.
   * 2. Optimistic CAS on `expectedRevisionSeq`.
   * 3. Monotonic `approvalGeneration` increment (`+1`), invalidating prior human attestations so
   *    re-pinned evidence can never inherit pre-edit signatures silently.
   */
  public async repinLiveEvidenceHashes(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly expectedRevisionSeq: number;
    readonly callerAccountId: string;
  }): Promise<EcoWorkspaceView> {
    await this.ensureProvisionedOrThrow();

    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (ws.revisionSeq !== params.expectedRevisionSeq) {
      throw new ConcurrentModificationError(
        `Stale workspace revisionSeq ${params.expectedRevisionSeq}; stored revisionSeq is ${ws.revisionSeq}.`
      );
    }

    const { liveEco, liveIssuesById } = await this.fetchLiveVerificationContext(
      params.projectKey,
      ws
    );

    const updatedEvidence = ws.catalog.evidenceRecords.map((ev) => {
      const live = liveIssuesById[ev.jiraIssueId];
      if (!live) {
        throw new Error(
          `Cannot re-pin evidence "${ev.evidenceId}": linked Jira issue "${ev.jiraIssueKey}" (id=${ev.jiraIssueId}) is unreachable.`
        );
      }
      if (live.statusCategoryKey.toLowerCase() !== "done") {
        throw new Error(
          `Cannot re-pin evidence "${ev.evidenceId}": linked Jira issue "${live.issueKey}" is in statusCategory "${live.statusCategoryKey}" (must be "done").`
        );
      }
      return {
        ...ev,
        jiraIssueKey: live.issueKey,
        pinnedIssueStateHash: computePinnedIssueStateHash(live)
      };
    });

    await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
      ecoIssueId: ws.ecoIssueId,
      updatedAtEpochMs: this.now(),
      catalog: {
        ...ws.catalog,
        evidenceRecords: updatedEvidence
      },
      eco: {
        ...ws.eco,
        lastEditorAccountId: params.callerAccountId,
        approvalGeneration: ws.eco.approvalGeneration + 1,
        liveEcoStatusCategoryKey: liveEco.statusCategoryKey
      },
      proposedOperations: ws.proposedOperations,
      attestations: ws.attestations,
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected:
        ws.unvalidatedDriftDetected || liveEco.statusCategoryKey.toLowerCase() === "done"
    });

    return this.getWorkspaceView({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      callerAccountId: params.callerAccountId
    });
  }

  /**
   * Generates a deterministic Release Assurance & Effectivity Disposition Record against live
   * Jira state and posts it as an immutable audit comment on the ECO work item.
   */
  public async postAuditRecordComment(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly callerAccountId: string;
  }): Promise<{
    readonly commentId: string;
    readonly view: EcoWorkspaceView;
  }> {
    const view = await this.getWorkspaceView({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      callerAccountId: params.callerAccountId
    });

    if (!view.workspace || !view.evaluation || !view.releaseAssuranceMarkdown) {
      throw new Error("Initialize the ECO verification workspace before exporting an audit record.");
    }
    if (!this.jira.postIssueComment) {
      throw new Error("Jira comment export is not configured on the active platform gateway.");
    }

    const targetIssue = view.workspace.eco.ecoJiraKey || params.ecoIssueId;
    const { commentId } = await this.jira.postIssueComment({
      issueIdOrKey: targetIssue,
      markdownText: view.releaseAssuranceMarkdown
    });

    return { commentId, view };
  }

  /**
   * Interactive Custom Component & Serial-Effectivity Substitution Studio:
   * Registers an engineer-defined ItemRevision (`APPROVED` or `DRAFT`) with typed quantitative
   * and enumerated attributes in the workspace catalog and commits serial-scoped BOM substitution
   * operations via Forge SQL CAS + monotonic `approvalGeneration` increment.
   */
  public async authorCustomComponentSubstitution(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly expectedRevisionSeq: number;
    readonly callerAccountId: string;
    readonly request: CustomComponentSubstitutionRequest;
  }): Promise<EcoWorkspaceView> {
    await this.ensureProvisionedOrThrow();

    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (ws.revisionSeq !== params.expectedRevisionSeq) {
      throw new ConcurrentModificationError(
        `Stale workspace revisionSeq ${params.expectedRevisionSeq}; stored revisionSeq is ${ws.revisionSeq}.`
      );
    }

    const req = params.request;
    const partNumber = req.partNumber.trim();
    const revision = req.revision.trim();
    const title = req.title.trim() || `${partNumber} Rev ${revision}`;
    if (!partNumber || !revision) {
      throw new Error("Both partNumber and revision are required to author a custom component.");
    }

    const { parentItemRevId, slotKey, baselineChildItemRev } = this.resolveBaselineSlotEdge(
      ws.catalog,
      req.targetSlotPath
    );

    const mergedAttributes: Record<string, ScalarValue> = {
      ...(baselineChildItemRev?.attributes ?? {})
    };
    const primaryKey = req.primaryNumericAttrKey.trim();
    const primaryUnit = req.primaryNumericUnit.trim();
    if (!primaryKey || !primaryUnit || !Number.isSafeInteger(req.primaryNumericValue) ||
        !Number.isSafeInteger(req.primaryNumericScale) || Math.abs(req.primaryNumericScale) > 18) {
      throw new Error(
        "Custom component requires an attribute key, unit, safe-integer mantissa and decimal scale in [-18, 18]."
      );
    }
    const scale = Number.isFinite(req.primaryNumericScale)
      ? Math.trunc(req.primaryNumericScale)
      : 0;
    mergedAttributes[primaryKey] = qty(
      Math.trunc(req.primaryNumericValue),
      scale,
      primaryUnit
    );

    if (req.secondaryEnumAttrKey?.trim() && req.secondaryEnumValue?.trim()) {
      mergedAttributes[req.secondaryEnumAttrKey.trim()] = enumVal(
        req.secondaryEnumValue.trim()
      );
    }

    const customItemRevId = `${partNumber}@${revision}`;
    const customItemRev: ItemRevision = {
      itemRevId: customItemRevId,
      partNumber,
      revision,
      title,
      itemKind: "COMPONENT",
      specStatus: req.specStatus,
      attributes: mergedAttributes
    };

    const nextItemRevisions = [
      ...ws.catalog.itemRevisions.filter((r) => r.itemRevId !== customItemRevId),
      customItemRev
    ];

    const safeSerialFrom =
      Number.isSafeInteger(req.serialFrom) && req.serialFrom >= 1000 ? req.serialFrom : 5000;
    const safeSerialTo =
      req.serialTo !== undefined &&
      req.serialTo !== null &&
      Number.isSafeInteger(req.serialTo) &&
      req.serialTo > safeSerialFrom
        ? req.serialTo
        : null;

    const ops = buildSerialScopedSubstitutionOps({
      currentEdges: ws.catalog.baselineBomEdges,
      allVariantIds: ws.catalog.variants.map((v) => v.variantId),
      parentItemRevId,
      slotKey,
      newChildItemRevId: customItemRevId,
      newEdgeIdPrefix: `E-CUSTOM-${partNumber.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`,
      targetVariants: req.targetVariants,
      serialFrom: safeSerialFrom,
      serialTo: safeSerialTo
    });

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);

    await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
      ecoIssueId: ws.ecoIssueId,
      updatedAtEpochMs: this.now(),
      catalog: {
        ...ws.catalog,
        itemRevisions: nextItemRevisions
      },
      eco: {
        ...ws.eco,
        lastEditorAccountId: params.callerAccountId,
        approvalGeneration: ws.eco.approvalGeneration + 1,
        liveEcoStatusCategoryKey: liveEco.statusCategoryKey
      },
      proposedOperations: ops,
      attestations: ws.attestations,
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected:
        ws.unvalidatedDriftDetected || liveEco.statusCategoryKey.toLowerCase() === "done"
    });

    return this.getWorkspaceView({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      callerAccountId: params.callerAccountId
    });
  }

  /**
   * Binds any existing live Jira issue (in `Done` statusCategory) to a governed obligation's
   * `VerificationEvidence` slot, registers its issue ID for workflow-validator pass-through,
   * pins its RFC 8785 SHA-256 content hash, and increments `approvalGeneration` via SQL CAS.
   */
  public async bindCustomJiraEvidenceTicket(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly expectedRevisionSeq: number;
    readonly callerAccountId: string;
    readonly request: BindJiraEvidenceRequest;
  }): Promise<EcoWorkspaceView> {
    await this.ensureProvisionedOrThrow();

    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (ws.revisionSeq !== params.expectedRevisionSeq) {
      throw new ConcurrentModificationError(
        `Stale workspace revisionSeq ${params.expectedRevisionSeq}; stored revisionSeq is ${ws.revisionSeq}.`
      );
    }

    const targetEvId = params.request.evidenceId.trim();
    const issueKeyOrId = params.request.jiraIssueKeyOrId.trim();
    if (!targetEvId || !issueKeyOrId) {
      throw new Error("Both evidenceId and jiraIssueKeyOrId are required.");
    }

    const existsInCatalog = ws.catalog.evidenceRecords.some(
      (ev) => ev.evidenceId === targetEvId
    );
    if (!existsInCatalog) {
      throw new Error(`Evidence slot "${targetEvId}" does not exist in catalog "${ws.catalog.familyId}".`);
    }

    const targetIssue = await this.jira.fetchLiveIssueByKeyOrId(issueKeyOrId);
    if (targetIssue.statusCategoryKey.toLowerCase() !== "done") {
      throw new Error(
        `Cannot bind Jira issue "${targetIssue.issueKey}" as qualification evidence until its statusCategory is "done" (current: "${targetIssue.statusCategoryKey}").`
      );
    }

    // A pre-existing Done ticket is already past the initial transition.
    // It must never gain a global release-gate exemption merely by being bound.
    if (targetIssue.projectKey !== params.projectKey) {
      throw new AuthorizationError(
        "Custom qualification evidence must belong to the ECO's Jira project."
      );
    }

    const pinnedHash = computePinnedIssueStateHash(targetIssue);
    const updatedEvidence = ws.catalog.evidenceRecords.map((ev) =>
      ev.evidenceId === targetEvId
        ? {
            ...ev,
            jiraIssueId: targetIssue.issueId,
            jiraIssueKey: targetIssue.issueKey,
            pinnedIssueStateHash: pinnedHash
          }
        : ev
    );

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);

    await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
      ecoIssueId: ws.ecoIssueId,
      updatedAtEpochMs: this.now(),
      catalog: {
        ...ws.catalog,
        evidenceRecords: updatedEvidence
      },
      eco: {
        ...ws.eco,
        lastEditorAccountId: params.callerAccountId,
        approvalGeneration: ws.eco.approvalGeneration + 1,
        liveEcoStatusCategoryKey: liveEco.statusCategoryKey
      },
      proposedOperations: ws.proposedOperations,
      attestations: ws.attestations,
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected:
        ws.unvalidatedDriftDetected || liveEco.statusCategoryKey.toLowerCase() === "done"
    });

    return this.getWorkspaceView({
      projectKey: params.projectKey,
      ecoIssueId: params.ecoIssueId,
      callerAccountId: params.callerAccountId
    });
  }

  /**
   * Evaluates all initialized ECO workspaces in a Jira project space against live Jira state,
   * aggregating fleet gate readiness, Strong Kleene K3 verdict distributions, and B0/B1/B2
   * industry baseline comparisons for the space-wide `LineLock Fleet Assurance` dashboard & Rovo MCP.
   */
  public async getProjectFleetOverview(params: {
    readonly projectKey: string;
    readonly callerAccountId?: string;
    /** Runtime-user-filtered, issue-security-aware check, before any aggregation. */
    readonly canViewWorkspace?: (workspace: StoredEcoWorkspace) => Promise<boolean>;
    readonly readOnly?: boolean;
  }): Promise<ProjectFleetOverview> {
    const provisioning = await this.provisioning.inspectStatus();
    const evaluatedAtEpochMs = this.now();

    if (provisioning.state !== "READY" || !this.store.listEcoWorkspaces) {
      return {
        projectKey: params.projectKey,
        provisioning,
        evaluatedAtEpochMs,
        totalEcos: 0,
        verifiedReleasedCount: 0,
        readyCount: 0,
        awaitingSignoffCount: 0,
        blockedCount: 0,
        driftAlertCount: 0,
        verdictDistribution: {
          supportedAsTested: 0,
          supportedByRule: 0,
          invalidated: 0,
          indeterminate: 0
        },
        baselineComparisonTotals: {
          b0Supported: 0,
          b1Supported: 0,
          b2Supported: 0,
          linelockSupported: 0,
          totalSliceObligations: 0
        },
        ecos: []
      };
    }

    const allWorkspaces = await this.store.listEcoWorkspaces();
    const normalizedProjectKey = params.projectKey.trim().toUpperCase();
    // Never interpret a missing, malformed, or wildcard key as a request for
    // all projects. Fleet aggregation must remain project-scoped.
    if (!/^[A-Z][A-Z0-9_]*$/.test(normalizedProjectKey)) {
      throw new AuthorizationError("Fleet overview requires a valid, explicit Jira project key.");
    }
    const projectCandidates = allWorkspaces.filter((ws) => {
      const key = ws.eco.ecoJiraKey.trim().toUpperCase();
      const boundary = key.lastIndexOf("-");
      return boundary > 0 && key.slice(0, boundary) === normalizedProjectKey;
    });
    // Filtering is performed BEFORE any totals or evidence evaluation so
    // restricted ECOs cannot leak through aggregate counts or verdicts.
    const permitted = params.canViewWorkspace
      ? await Promise.all(
          projectCandidates.map(async (ws) => ({
            ws,
            allowed: await params.canViewWorkspace!(ws)
          }))
        )
      : projectCandidates.map((ws) => ({ ws, allowed: true }));
    const matching = permitted.filter((row) => row.allowed).map((row) => row.ws);

    let verifiedReleasedCount = 0;
    let readyCount = 0;
    let awaitingSignoffCount = 0;
    let blockedCount = 0;
    let driftAlertCount = 0;

    let supportedAsTested = 0;
    let supportedByRule = 0;
    let invalidated = 0;
    let indeterminate = 0;

    let b0Supported = 0;
    let b1Supported = 0;
    let b2Supported = 0;
    let linelockSupported = 0;
    let totalSliceObligations = 0;

    const ecoRows: FleetEcoSummaryRow[] = [];

    for (const rawWs of matching) {
      const targetProjectKey =
        normalizedProjectKey && normalizedProjectKey !== "*"
          ? params.projectKey
          : (rawWs.eco.ecoJiraKey.split("-")[0] ?? "ECO");

      const ws = params.readOnly
        ? rawWs
        : await this.maybeFinalizePendingTransitionIntent(
            targetProjectKey,
            rawWs.ecoIssueId,
            rawWs
          );

      let evaluated;
      try {
        evaluated = await this.evaluateWorkspaceWithIntegrity(
          targetProjectKey,
          ws,
          undefined,
          undefined,
          params.callerAccountId
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("HTTP 404")) {
          // Skip orphaned SQL workspaces whose Jira work item was permanently deleted
          continue;
        }
        throw err;
      }

      const { evaluation, evidenceIntegrity, baselineSummary } = evaluated;

      if (evaluation.gateState === "RELEASE_TRANSITIONED_VERIFIED") {
        verifiedReleasedCount++;
      } else if (evaluation.gateState === "READY_FOR_RELEASE_TRANSITION") {
        readyCount++;
      } else if (evaluation.gateState === "AWAITING_ATTESTATION") {
        awaitingSignoffCount++;
      } else {
        blockedCount++;
      }

      const healthyPins = evidenceIntegrity.filter(
        (row) => row.statusIsDone && row.hashMatches
      ).length;
      if (
        evaluation.gateState === "UNVALIDATED_RELEASE_DRIFT" ||
        healthyPins < evidenceIntegrity.length
      ) {
        driftAlertCount++;
      }

      for (const so of evaluation.sliceObligations) {
        if (so.status === "SUPPORTED_AS_TESTED") supportedAsTested++;
        else if (so.status === "SUPPORTED_BY_APPROVED_RULE") supportedByRule++;
        else if (so.status.startsWith("INVALIDATED_")) invalidated++;
        else indeterminate++;
      }

      b0Supported += baselineSummary.b0Supported;
      b1Supported += baselineSummary.b1Supported;
      b2Supported += baselineSummary.b2Supported;
      linelockSupported += baselineSummary.linelockSupported;
      totalSliceObligations += baselineSummary.totalSliceObligations;

      ecoRows.push({
        ecoIssueId: ws.ecoIssueId,
        ecoIssueKey: ws.eco.ecoJiraKey || ws.ecoIssueId,
        familyId: ws.catalog.familyId,
        gateState: evaluation.gateState,
        transitionAllowed: evaluation.transitionAllowed,
        snapshotSha256: evaluation.snapshotSha256,
        approvalGeneration: ws.eco.approvalGeneration,
        revisionSeq: ws.revisionSeq,
        policyId: ws.catalog.policy.policyId,
        policyVersion: ws.catalog.policy.policyVersion,
        sliceCount: evaluation.slices.length,
        supportedObligations: baselineSummary.linelockSupported,
        totalObligations: evaluation.sliceObligations.length,
        evidencePinHealthyCount: healthyPins,
        totalEvidenceCount: evidenceIntegrity.length,
        updatedAtEpochMs: ws.updatedAtEpochMs
      });
    }

    ecoRows.sort((a, b) => b.updatedAtEpochMs - a.updatedAtEpochMs);

    return {
      projectKey: params.projectKey,
      provisioning,
      evaluatedAtEpochMs,
      totalEcos: ecoRows.length,
      verifiedReleasedCount,
      readyCount,
      awaitingSignoffCount,
      blockedCount,
      driftAlertCount,
      verdictDistribution: {
        supportedAsTested,
        supportedByRule,
        invalidated,
        indeterminate
      },
      baselineComparisonTotals: {
        b0Supported,
        b1Supported,
        b2Supported,
        linelockSupported,
        totalSliceObligations
      },
      ecos: ecoRows
    };
  }

  public async validateReleaseTransition(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly actorAccountId: string;
  }): Promise<WorkflowValidatorResponse> {
    try {
      const prov = await this.provisioning.inspectStatus();
      if (prov.state !== "READY") {
        return {
          result: false,
          errorMessage: `LineLock block: Forge SQL storage is ${prov.state} (fail-closed until schema migrations complete).`
        };
      }

      const ws = await this.store.getEcoWorkspace(params.ecoIssueId);
      if (!ws) {
        // A historical global evidence-ID registry must not be an authorization
        // capability. An arbitrary Done issue could otherwise be registered and
        // later transition uninitialized ECOs without verification.
        //
        // Only actual Jira issue types determine whether an uninitialized work
        // item belongs to the configured ECO class. Unknown type fails closed.
        const liveIssue = await this.jira.fetchLiveIssue(params.ecoIssueId);
        const issueType = liveIssue.issueTypeName?.trim().toLowerCase();
        if (
          issueType &&
          issueType !== "engineering change order" &&
          issueType !== "engineering change" &&
          issueType !== "eco" &&
          issueType !== "change"
        ) {
          return { result: true };
        }
        return {
          result: false,
          errorMessage: `LineLock block: No initialized engineering verification workspace for ECO issue ${params.ecoIssueId}.`
        };
      }

      const liveEval = await this.evaluateWorkspaceAgainstLiveJira(params.projectKey, ws);
      if (liveEval.gateState !== "READY_FOR_RELEASE_TRANSITION") {
        const detail = liveEval.blockingReasons[0] ?? `Current gate state is ${liveEval.gateState}`;
        return {
          result: false,
          errorMessage: `LineLock [${liveEval.gateState}]: ${detail}`
        };
      }

      const issuedAt = this.now();
      const pendingIntent: PendingTransitionIntent = {
        intentId: `intent-${randomUUID()}`,
        ecoJiraIssueId: ws.ecoIssueId,
        verifiedSnapshotSha256: liveEval.snapshotSha256,
        verifiedApprovalGeneration: ws.eco.approvalGeneration,
        verifiedPolicyVersion: ws.catalog.policy.policyVersion,
        actorAccountId: params.actorAccountId,
        issuedAtEpochMs: issuedAt,
        expiresAtEpochMs: issuedAt + this.intentTtlMs
      };

      await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
        ecoIssueId: ws.ecoIssueId,
        updatedAtEpochMs: issuedAt,
        catalog: ws.catalog,
        eco: ws.eco,
        proposedOperations: ws.proposedOperations,
        attestations: ws.attestations,
        pendingTransitionIntent: pendingIntent,
        finalizedReleaseReceipt: null,
        unvalidatedDriftDetected: false
      });

      return { result: true };
    } catch (err) {
      if (err instanceof ConcurrentModificationError) {
        return {
          result: false,
          errorMessage:
            "LineLock block: Concurrent modification detected during workflow validation; re-verify and retry transition."
        };
      }
      return {
        result: false,
        errorMessage: `LineLock fail-closed internal error: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  public async reconcileIssueUpdatedEvent(params: {
    readonly projectKey: string;
    readonly updatedIssueId: string;
    readonly ecoIssueId?: string;
  }): Promise<VerificationEvaluation | null> {
    const prov = await this.provisioning.inspectStatus();
    if (prov.state !== "READY") {
      return null;
    }

    const targetEcoId = params.ecoIssueId ?? params.updatedIssueId;
    const ws = await this.store.getEcoWorkspace(targetEcoId);
    if (!ws) {
      return null;
    }

    const liveEco = await this.jira.fetchLiveIssue(targetEcoId);
    const nowMs = this.now();
    const isDone = liveEco.statusCategoryKey.toLowerCase() === "done";

    if (!isDone) {
      const intentExpired =
        ws.pendingTransitionIntent !== null && ws.pendingTransitionIntent.expiresAtEpochMs <= nowMs;
      const statusChanged = ws.eco.liveEcoStatusCategoryKey !== liveEco.statusCategoryKey;

      if (!intentExpired && !statusChanged) {
        return this.evaluateWorkspaceAgainstLiveJira(params.projectKey, ws);
      }

      const updated = await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
        ecoIssueId: ws.ecoIssueId,
        updatedAtEpochMs: nowMs,
        catalog: ws.catalog,
        eco: {
          ...ws.eco,
          liveEcoStatusCategoryKey: liveEco.statusCategoryKey
        },
        proposedOperations: ws.proposedOperations,
        attestations: ws.attestations,
        pendingTransitionIntent: intentExpired ? null : ws.pendingTransitionIntent,
        finalizedReleaseReceipt: null,
        unvalidatedDriftDetected: ws.unvalidatedDriftDetected
      });
      return this.evaluateWorkspaceAgainstLiveJira(params.projectKey, updated);
    }

    const probeWsPreDone: StoredEcoWorkspace = {
      ...ws,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected: false
    };
    const preDoneEval = await this.evaluateWorkspaceAgainstLiveJira(
      params.projectKey,
      probeWsPreDone,
      undefined,
      "indeterminate"
    );

    if (
      ws.finalizedReleaseReceipt &&
      !ws.unvalidatedDriftDetected &&
      preDoneEval.gateState === "READY_FOR_RELEASE_TRANSITION" &&
      ws.finalizedReleaseReceipt.verifiedSnapshotSha256 === preDoneEval.snapshotSha256 &&
      ws.finalizedReleaseReceipt.verifiedApprovalGeneration === ws.eco.approvalGeneration &&
      ws.finalizedReleaseReceipt.verifiedPolicyVersion === ws.catalog.policy.policyVersion
    ) {
      if (ws.eco.liveEcoStatusCategoryKey !== "done") {
        const synced = await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
          ...ws,
          updatedAtEpochMs: nowMs,
          eco: { ...ws.eco, liveEcoStatusCategoryKey: liveEco.statusCategoryKey }
        });
        return this.evaluateWorkspaceAgainstLiveJira(params.projectKey, synced);
      }
      return this.evaluateWorkspaceAgainstLiveJira(params.projectKey, ws);
    }

    const intent = ws.pendingTransitionIntent;
    const intentValidForLiveState =
      intent !== null &&
      intent.ecoJiraIssueId === ws.ecoIssueId &&
      intent.expiresAtEpochMs > nowMs &&
      preDoneEval.gateState === "READY_FOR_RELEASE_TRANSITION" &&
      intent.verifiedSnapshotSha256 === preDoneEval.snapshotSha256 &&
      intent.verifiedApprovalGeneration === ws.eco.approvalGeneration &&
      intent.verifiedPolicyVersion === ws.catalog.policy.policyVersion;

    if (intentValidForLiveState && intent) {
      const receipt: FinalizedReleaseReceipt = {
        receiptId: `receipt-${randomUUID()}`,
        sourceIntentId: intent.intentId,
        ecoJiraIssueId: ws.ecoIssueId,
        verifiedSnapshotSha256: preDoneEval.snapshotSha256,
        verifiedApprovalGeneration: ws.eco.approvalGeneration,
        verifiedPolicyVersion: ws.catalog.policy.policyVersion,
        finalizedAtEpochMs: nowMs
      };

      const promoted = await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
        ecoIssueId: ws.ecoIssueId,
        updatedAtEpochMs: nowMs,
        catalog: ws.catalog,
        eco: {
          ...ws.eco,
          liveEcoStatusCategoryKey: liveEco.statusCategoryKey
        },
        proposedOperations: ws.proposedOperations,
        attestations: ws.attestations,
        pendingTransitionIntent: null,
        finalizedReleaseReceipt: receipt,
        unvalidatedDriftDetected: false
      });

      return this.evaluateWorkspaceAgainstLiveJira(params.projectKey, promoted);
    }

    const drifted = await this.store.casUpdateEcoWorkspace(ws.revisionSeq, {
      ecoIssueId: ws.ecoIssueId,
      updatedAtEpochMs: nowMs,
      catalog: ws.catalog,
      eco: {
        ...ws.eco,
        liveEcoStatusCategoryKey: liveEco.statusCategoryKey
      },
      proposedOperations: ws.proposedOperations,
      attestations: ws.attestations,
      pendingTransitionIntent: null,
      finalizedReleaseReceipt: null,
      unvalidatedDriftDetected: true
    });

    return this.evaluateWorkspaceAgainstLiveJira(params.projectKey, drifted);
  }

  /**
   * Read-only baseline comparison on the currently committed ECO state (for Rovo / analytics).
   */
  public async compareCurrentEcoAgainstBaselines(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly readOnly?: boolean;
  }) {
    if (params.readOnly) await this.requireAlreadyProvisioned();
    else await this.ensureProvisionedOrThrow();
    let ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (!params.readOnly) {
      ws = await this.maybeFinalizePendingTransitionIntent(
        params.projectKey,
        params.ecoIssueId,
        ws
      );
    }
    const { liveEco, trustedRoles, liveIssuesById } = await this.fetchLiveVerificationContext(
      params.projectKey,
      ws
    );

    const input: VerificationInput = {
      catalog: ws.catalog,
      eco: {
        ...ws.eco,
        liveEcoStatusCategoryKey: liveEco.statusCategoryKey
      },
      proposedOperations: ws.proposedOperations,
      liveVerificationIssuesById: liveIssuesById,
      attestations: ws.attestations,
      trustedRoleMembersByRole: trustedRoles,
      pendingTransitionIntent: ws.pendingTransitionIntent,
      finalizedReleaseReceipt: ws.finalizedReleaseReceipt,
      unvalidatedDriftDetected: ws.unvalidatedDriftDetected
    };

    const linelock = verifyEngineeringChange(input);
    const b0 = evaluateB0TimestampStatus(input);
    const b1 = evaluateB1UntypedSuspectGraph(input);
    const b2 = evaluateB2CompetentVersionAndEnvelope(input);

    return { linelock, b0, b1, b2 };
  }

  private buildOperationsForPreset(
    catalog: FamilyCatalog,
    presetId: ScenarioPresetId
  ): ChangeOperation[] {
    const isMedTech = catalog.familyId.startsWith("PULSEGUARD");
    const isAero = catalog.familyId.startsWith("AEGIS");
    const safeVariantId = inferScopedSafeVariantForCatalog(catalog);

    switch (presetId) {
      case "BASELINE":
        return [];
      case "CAP_REV_C_ALL_5000":
        if (isMedTech || isAero) {
          return buildFlagshipSubstitutionForCatalog({
            catalog,
            targetVariants: "ALL",
            serialFrom: 5000
          });
        }
        return buildHeliosCapRevCSubstitution(catalog, "ALL", 5000);
      case "CAP_REV_C_400V_5000":
        if (isMedTech || isAero) {
          return buildFlagshipSubstitutionForCatalog({
            catalog,
            targetVariants: [safeVariantId],
            serialFrom: 5000
          });
        }
        return buildHeliosCapRevCSubstitution(catalog, ["VAR_400V"], 5000);
      case "COLD_SOAK_MINUS_40C": {
        if (isMedTech) {
          const baseVar = catalog.variants.find((v) => v.variantId === "VAR_ADULT_ICU");
          return [
            {
              op: "SET_VARIANT_ENVELOPE",
              variantId: "VAR_ADULT_ICU",
              operatingEnvelope: {
                ...(baseVar?.operatingEnvelope ?? {}),
                min_ambient: qty(0, 0, "degC"),
                max_ambient: qty(40, 0, "degC")
              }
            }
          ];
        }
        if (isAero) {
          const baseVar = catalog.variants.find((v) => v.variantId === "VAR_REGIONAL_TURBOPROP");
          return [
            {
              op: "SET_VARIANT_ENVELOPE",
              variantId: "VAR_REGIONAL_TURBOPROP",
              operatingEnvelope: {
                ...(baseVar?.operatingEnvelope ?? {}),
                min_ambient: qty(-50, 0, "degC"),
                max_ambient: qty(70, 0, "degC")
              }
            }
          ];
        }
        return [
          {
            op: "SET_VARIANT_ENVELOPE",
            variantId: "VAR_400V",
            operatingEnvelope: {
              bus_voltage: qty(400, 0, "V"),
              max_ambient: qty(55, 0, "degC"),
              min_ambient: qty(-40, 0, "degC"),
              aux_rail_voltage: qty(12, 0, "V")
            }
          }
        ];
      }
      case "SEAL_REV_B_3000":
        if (isMedTech) {
          return buildSerialScopedSubstitutionOps({
            currentEdges: catalog.baselineBomEdges,
            allVariantIds: catalog.variants.map((v) => v.variantId),
            parentItemRevId: "PUMP-PULSEGUARD@A",
            slotKey: "FLUID_SEAL_G1",
            newChildItemRevId: "TUBE-SIL@B",
            newEdgeIdPrefix: "E-PRESET-SEAL",
            targetVariants: [safeVariantId],
            serialFrom: 3000,
            serialTo: null
          });
        }
        if (isAero) {
          return buildSerialScopedSubstitutionOps({
            currentEdges: catalog.baselineBomEdges,
            allVariantIds: catalog.variants.map((v) => v.variantId),
            parentItemRevId: "EHA-AEGIS@A",
            slotKey: "ALTITUDE_VENT_V1",
            newChildItemRevId: "VENT-PTFE@B",
            newEdgeIdPrefix: "E-PRESET-SEAL",
            targetVariants: [safeVariantId],
            serialFrom: 3000,
            serialTo: null
          });
        }
        return buildSerialScopedSubstitutionOps({
          currentEdges: catalog.baselineBomEdges,
          allVariantIds: catalog.variants.map((v) => v.variantId),
          parentItemRevId: "PACK-HELIOS@A",
          slotKey: "ENCLOSURE_SEAL_S1",
          newChildItemRevId: "SEAL-EPDM@B",
          newEdgeIdPrefix: "E-PRESET-SEAL",
          targetVariants: ["VAR_400V"],
          serialFrom: 3000,
          serialTo: null
        });
    }
  }

  private buildOperationsForCounterfactual(
    catalog: FamilyCatalog,
    req: CounterfactualRequest
  ): ChangeOperation[] {
    const isMedTech = catalog.familyId.startsWith("PULSEGUARD");
    const isAero = catalog.familyId.startsWith("AEGIS");
    const allVariantIds = catalog.variants.map((v) => v.variantId);

    const normalizeVariantId = (vid: string): string => {
      if (allVariantIds.includes(vid)) return vid;
      if (vid === "VAR_800V" && allVariantIds[1]) return allVariantIds[1];
      return inferScopedSafeVariantForCatalog(catalog);
    };

    if (req.kind === "AMBIENT_ENVELOPE_SHIFT") {
      const resolvedVarId = normalizeVariantId(req.variantId);
      const targetVar = catalog.variants.find((v) => v.variantId === resolvedVarId);
      return [
        {
          op: "SET_VARIANT_ENVELOPE",
          variantId: resolvedVarId,
          operatingEnvelope: {
            ...(targetVar?.operatingEnvelope ?? {}),
            max_ambient: qty(Math.trunc(req.maxAmbientC), 0, "degC"),
            min_ambient: qty(Math.trunc(req.minAmbientC), 0, "degC")
          }
        }
      ];
    }

    const safeSerial =
      Number.isSafeInteger(req.serialFrom) && req.serialFrom >= 1000 ? req.serialFrom : 5000;
    const safeSerialTo =
      req.serialTo !== undefined &&
      req.serialTo !== null &&
      Number.isSafeInteger(req.serialTo) &&
      req.serialTo > safeSerial
        ? req.serialTo
        : null;

    const normalizedTargets: "ALL" | readonly string[] =
      req.targetVariants === "ALL"
        ? "ALL"
        : req.targetVariants.map((v) => normalizeVariantId(v));

    switch (req.kind) {
      case "CAP_REV_C_CUTOVER":
        if (isMedTech || isAero) {
          return buildFlagshipSubstitutionForCatalog({
            catalog,
            targetVariants: normalizedTargets,
            serialFrom: safeSerial,
            serialTo: safeSerialTo
          });
        }
        return buildSerialScopedSubstitutionOps({
          currentEdges: catalog.baselineBomEdges,
          allVariantIds,
          parentItemRevId: "HV_INV@A",
          slotKey: "DC_LINK_CAP_C14",
          newChildItemRevId: "CAP-1210@C",
          newEdgeIdPrefix: "E-CF-CAPC",
          targetVariants: normalizedTargets,
          serialFrom: safeSerial,
          serialTo: safeSerialTo
        });
      case "CAP_REV_D_DRAFT_CUTOVER":
        if (isMedTech) {
          return buildSerialScopedSubstitutionOps({
            currentEdges: catalog.baselineBomEdges,
            allVariantIds,
            parentItemRevId: "PUMP_DRV@A",
            slotKey: "FLOW_SENSOR_S1",
            newChildItemRevId: "SENS-MEMS@C_DRAFT",
            newEdgeIdPrefix: "E-CF-DRAFT",
            targetVariants: normalizedTargets,
            serialFrom: safeSerial,
            serialTo: safeSerialTo
          });
        }
        return buildSerialScopedSubstitutionOps({
          currentEdges: catalog.baselineBomEdges,
          allVariantIds,
          parentItemRevId: "HV_INV@A",
          slotKey: "DC_LINK_CAP_C14",
          newChildItemRevId: "CAP-1210@D_DRAFT",
          newEdgeIdPrefix: "E-CF-CAPD",
          targetVariants: normalizedTargets,
          serialFrom: safeSerial,
          serialTo: safeSerialTo
        });
      case "GATE_DRIVER_REV_B_CUTOVER":
        return buildSerialScopedSubstitutionOps({
          currentEdges: catalog.baselineBomEdges,
          allVariantIds,
          parentItemRevId: "HV_INV@A",
          slotKey: "GATE_DRIVER_U3",
          newChildItemRevId: "DRV-ISO@B",
          newEdgeIdPrefix: "E-CF-DRVB",
          targetVariants: normalizedTargets,
          serialFrom: safeSerial,
          serialTo: safeSerialTo
        });
      case "SEAL_REV_B_CUTOVER":
        if (isMedTech) {
          return buildSerialScopedSubstitutionOps({
            currentEdges: catalog.baselineBomEdges,
            allVariantIds,
            parentItemRevId: "PUMP-PULSEGUARD@A",
            slotKey: "FLUID_SEAL_G1",
            newChildItemRevId: "TUBE-SIL@B",
            newEdgeIdPrefix: "E-CF-SEAL",
            targetVariants: normalizedTargets,
            serialFrom: safeSerial,
            serialTo: safeSerialTo
          });
        }
        if (isAero) {
          return buildSerialScopedSubstitutionOps({
            currentEdges: catalog.baselineBomEdges,
            allVariantIds,
            parentItemRevId: "EHA-AEGIS@A",
            slotKey: "ALTITUDE_VENT_V1",
            newChildItemRevId: "VENT-PTFE@B",
            newEdgeIdPrefix: "E-CF-SEAL",
            targetVariants: normalizedTargets,
            serialFrom: safeSerial,
            serialTo: safeSerialTo
          });
        }
        return buildSerialScopedSubstitutionOps({
          currentEdges: catalog.baselineBomEdges,
          allVariantIds,
          parentItemRevId: "PACK-HELIOS@A",
          slotKey: "ENCLOSURE_SEAL_S1",
          newChildItemRevId: "SEAL-EPDM@B",
          newEdgeIdPrefix: "E-CF-SEAL",
          targetVariants: normalizedTargets,
          serialFrom: safeSerial,
          serialTo: safeSerialTo
        });
    }
  }

  private resolveBaselineSlotEdge(
    catalog: FamilyCatalog,
    targetSlotPath: string
  ): {
    readonly parentItemRevId: string;
    readonly slotKey: string;
    readonly baselineChildItemRev: ItemRevision | undefined;
  } {
    const segments = targetSlotPath
      .trim()
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      throw new Error("targetSlotPath is required.");
    }

    let currentParentRevId = catalog.rootAssemblyRevId;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const edge = catalog.baselineBomEdges.find(
        (e) => e.parentItemRevId === currentParentRevId && e.slotKey === seg
      );
      if (!edge) {
        throw new Error(
          `Slot path "${targetSlotPath}" could not be resolved at segment "${seg}" under parent "${currentParentRevId}".`
        );
      }
      if (i === segments.length - 1) {
        const baselineChildItemRev = catalog.itemRevisions.find(
          (r) => r.itemRevId === edge.childItemRevId
        );
        return {
          parentItemRevId: edge.parentItemRevId,
          slotKey: edge.slotKey,
          baselineChildItemRev
        };
      }
      currentParentRevId = edge.childItemRevId;
    }

    throw new Error(`Unable to resolve slot path "${targetSlotPath}".`);
  }

  private async maybeFinalizePendingTransitionIntent(
    projectKey: string,
    ecoIssueId: string,
    ws: StoredEcoWorkspace
  ): Promise<StoredEcoWorkspace> {
    if (!ws.pendingTransitionIntent) {
      return ws;
    }

    const intentExpired = ws.pendingTransitionIntent.expiresAtEpochMs <= this.now();
    let ecoReachedDone = false;
    if (!intentExpired) {
      try {
        const liveEco = await this.jira.fetchLiveIssue(ecoIssueId);
        ecoReachedDone = liveEco.statusCategoryKey.toLowerCase() === "done";
      } catch {
        return ws;
      }
    }

    if (!intentExpired && !ecoReachedDone) {
      return ws;
    }

    try {
      await this.reconcileIssueUpdatedEvent({
        projectKey,
        updatedIssueId: ecoIssueId,
        ecoIssueId
      });
    } catch (err) {
      if (!(err instanceof ConcurrentModificationError)) {
        throw err;
      }
    }

    return (await this.store.getEcoWorkspace(ecoIssueId)) ?? ws;
  }

  private async fetchLiveVerificationContext(
    projectKey: string,
    ws: StoredEcoWorkspace,
    cachedRoles?: Record<string, readonly string[]>,
    extraCandidateAccountId?: string
  ): Promise<{
    readonly liveEco: LiveJiraIssueProjection;
    readonly trustedRoles: Record<string, readonly string[]>;
    readonly liveIssuesById: Record<string, LiveJiraIssueProjection>;
  }> {
    const uniqueEvidenceIssueIds = [
      ...new Set(ws.catalog.evidenceRecords.map((ev) => ev.jiraIssueId))
    ];

    const candidateAccountIds = [
      ...(extraCandidateAccountId ? [extraCandidateAccountId] : []),
      ...ws.attestations.map((a) => a.signerAccountId)
    ];

    const [liveEco, trustedRoles, ...liveEvidenceList] = await Promise.all([
      this.jira.fetchLiveIssue(ws.ecoIssueId),
      cachedRoles
        ? Promise.resolve(cachedRoles)
        : this.jira.fetchProjectRoleMembers(
            projectKey,
            this.collectAllPossibleRoles(ws.catalog),
            candidateAccountIds
          ),
      ...uniqueEvidenceIssueIds.map(async (issueId) => {
        try {
          return await this.jira.fetchLiveIssue(issueId);
        } catch {
          return null;
        }
      })
    ]);

    const liveIssuesById: Record<string, LiveJiraIssueProjection> = {};
    for (const item of liveEvidenceList) {
      if (item) {
        liveIssuesById[item.issueId] = item;
      }
    }

    return { liveEco, trustedRoles, liveIssuesById };
  }

  private async evaluateWorkspaceWithIntegrity(
    projectKey: string,
    ws: StoredEcoWorkspace,
    cachedRoles?: Record<string, readonly string[]>,
    overrideEcoStatusCategoryKey?: string,
    extraCandidateAccountId?: string
  ): Promise<{
    readonly evaluation: VerificationEvaluation;
    readonly evidenceIntegrity: readonly LiveEvidenceIntegrityRow[];
    readonly baselineSummary: BaselineTotalsSummary;
  }> {
    const { liveEco, trustedRoles, liveIssuesById } = await this.fetchLiveVerificationContext(
      projectKey,
      ws,
      cachedRoles,
      extraCandidateAccountId
    );

    const effectiveStatus = overrideEcoStatusCategoryKey ?? liveEco.statusCategoryKey;

    const verInput: VerificationInput = {
      catalog: ws.catalog,
      eco: {
        ...ws.eco,
        liveEcoStatusCategoryKey: effectiveStatus
      },
      proposedOperations: ws.proposedOperations,
      liveVerificationIssuesById: liveIssuesById,
      attestations: ws.attestations,
      trustedRoleMembersByRole: trustedRoles,
      pendingTransitionIntent: ws.pendingTransitionIntent,
      finalizedReleaseReceipt: ws.finalizedReleaseReceipt,
      unvalidatedDriftDetected: ws.unvalidatedDriftDetected
    };

    const evaluation = verifyEngineeringChange(verInput);
    const b0 = evaluateB0TimestampStatus(verInput);
    const b1 = evaluateB1UntypedSuspectGraph(verInput);
    const b2 = evaluateB2CompetentVersionAndEnvelope(verInput);

    const baselineSummary: BaselineTotalsSummary = {
      b0Supported: b0.filter((r) => r.verdict === "SUPPORTED").length,
      b1Supported: b1.filter((r) => r.verdict === "SUPPORTED").length,
      b2Supported: b2.filter((r) => r.verdict === "SUPPORTED").length,
      linelockSupported: countSupported(evaluation),
      totalSliceObligations: evaluation.sliceObligations.length
    };

    const oblCodeById = new Map(ws.catalog.obligations.map((o) => [o.obligationId, o.code]));
    const evidenceIntegrity: LiveEvidenceIntegrityRow[] = ws.catalog.evidenceRecords.map((ev) => {
      const live = liveIssuesById[ev.jiraIssueId];
      const liveHash = live ? computePinnedIssueStateHash(live) : null;
      const statusIsDone = Boolean(live && live.statusCategoryKey.toLowerCase() === "done");
      return {
        evidenceId: ev.evidenceId,
        obligationId: ev.obligationId,
        obligationCode: oblCodeById.get(ev.obligationId) ?? ev.obligationId,
        testedVariantId: ev.testedVariantId,
        jiraIssueId: ev.jiraIssueId,
        jiraIssueKey: live?.issueKey ?? ev.jiraIssueKey,
        pinnedIssueStateHash: ev.pinnedIssueStateHash,
        liveIssueStateHash: liveHash,
        liveSummary: live?.summary ?? null,
        liveStatusCategoryKey: live?.statusCategoryKey ?? null,
        isReachable: Boolean(live),
        statusIsDone,
        hashMatches: liveHash !== null && liveHash === ev.pinnedIssueStateHash
      };
    });

    return { evaluation, evidenceIntegrity, baselineSummary };
  }

  private async evaluateWorkspaceAgainstLiveJira(
    projectKey: string,
    ws: StoredEcoWorkspace,
    cachedRoles?: Record<string, readonly string[]>,
    overrideEcoStatusCategoryKey?: string
  ): Promise<VerificationEvaluation> {
    const { evaluation } = await this.evaluateWorkspaceWithIntegrity(
      projectKey,
      ws,
      cachedRoles,
      overrideEcoStatusCategoryKey
    );
    return evaluation;
  }

  private collectAllPossibleRoles(catalog: FamilyCatalog): string[] {
    const roles = new Set<string>(catalog.policy.requiredAttestationRoles);
    if (catalog.policy.carryForwardDispositionRole) {
      roles.add(catalog.policy.carryForwardDispositionRole);
    }
    return [...roles].sort();
  }

  /** Rovo GET must never trigger lazy DDL or migrations. */
  private async requireAlreadyProvisioned(): Promise<void> {
    const status = await this.provisioning.inspectStatus();
    if (status.state !== "READY") {
      throw new ProvisioningNotReadyError(
        status.state,
        "LineLock SQL is not ready. An administrator must complete provisioning outside Rovo."
      );
    }
  }

  private async ensureProvisionedOrThrow(): Promise<void> {
    let status = await this.provisioning.inspectStatus();
    if (status.state === "UNPROVISIONED") {
      status = await this.provisioning.runMigrations("lazy-on-demand");
    }
    if (status.state !== "READY") {
      throw new ProvisioningNotReadyError(
        status.state,
        `Forge SQL schema is not READY (state=${status.state}, error=${status.lastErrorCode ?? "none"}: ${status.lastErrorMessage ?? ""}).`
      );
    }
  }

  private async mustLoadWorkspace(ecoIssueId: string): Promise<StoredEcoWorkspace> {
    const ws = await this.store.getEcoWorkspace(ecoIssueId);
    if (!ws) {
      throw new Error(`No workspace found for ECO issue "${ecoIssueId}".`);
    }
    return ws;
  }
}
