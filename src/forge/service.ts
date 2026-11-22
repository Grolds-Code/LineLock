import { randomUUID } from "node:crypto";
import {
  evaluateB0TimestampStatus,
  evaluateB1UntypedSuspectGraph,
  evaluateB2CompetentVersionAndEnvelope
} from "../core/baselines";
import { computePinnedIssueStateHash } from "../core/canonical";
import { buildSerialScopedSubstitutionOps } from "../core/intervals";
import {
  qty,
  type ChangeOperation,
  type EcoMetadata,
  type FamilyCatalog,
  type FinalizedReleaseReceipt,
  type LiveJiraIssueProjection,
  type PendingTransitionIntent,
  type RoleAttestation,
  type VerificationEvaluation,
  type VerificationInput,
  type VerificationPolicy
} from "../core/types";
import { verifyEngineeringChange } from "../core/verifier";
import {
  buildHeliosCapRevCSubstitution,
  createHeliosCatalog,
  createHeliosDefaultEco,
  createHeliosLiveIssues
} from "../scenarios/heliosBatteryPack";
import {
  AuthorizationError,
  ConcurrentModificationError,
  ProvisioningNotReadyError,
  StaleGenerationError,
  StaleSnapshotError,
  type ConnectivityProbeResult,
  type CounterfactualRequest,
  type CounterfactualSimulationResult,
  type EcoWorkspaceView,
  type GovernancePolicyMode,
  type JiraPlatformGateway,
  type LiveEvidenceIntegrityRow,
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

    const workspace = await this.store.getEcoWorkspace(params.ecoIssueId);
    if (!workspace) {
      return {
        callerAccountId: params.callerAccountId,
        provisioning,
        workspace: null,
        evaluation: null,
        evidenceIntegrity: []
      };
    }

    const { evaluation, evidenceIntegrity } = await this.evaluateWorkspaceWithIntegrity(
      params.projectKey,
      workspace
    );
    return {
      callerAccountId: params.callerAccountId,
      provisioning,
      workspace,
      evaluation,
      evidenceIntegrity
    };
  }

  public async seedReferenceWorkspace(params: {
    readonly ecoIssueId: string;
    readonly ecoIssueKey: string;
    readonly callerAccountId: string;
    readonly catalog?: FamilyCatalog;
  }): Promise<StoredEcoWorkspace> {
    await this.ensureProvisionedOrThrow();

    const existing = await this.store.getEcoWorkspace(params.ecoIssueId);
    if (existing) {
      return existing;
    }

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);
    const defaultEco = createHeliosDefaultEco();
    const catalog = params.catalog ?? createHeliosCatalog(createHeliosLiveIssues());

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
   */
  public async provisionLiveJiraWorkspace(params: {
    readonly projectKey: string;
    readonly ecoIssueId: string;
    readonly ecoIssueKey: string;
    readonly callerAccountId: string;
  }): Promise<EcoWorkspaceView> {
    await this.ensureProvisionedOrThrow();

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);
    const resolvedEcoKey = params.ecoIssueKey || liveEco.issueKey;

    const referenceIssues = createHeliosLiveIssues();
    const templateCatalog = createHeliosCatalog(referenceIssues);

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
  }): Promise<CounterfactualSimulationResult> {
    await this.ensureProvisionedOrThrow();
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

    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
    if (ws.revisionSeq !== params.expectedRevisionSeq) {
      throw new ConcurrentModificationError(
        `Stale workspace revisionSeq ${params.expectedRevisionSeq}; stored revisionSeq is ${ws.revisionSeq}.`
      );
    }

    const liveEco = await this.jira.fetchLiveIssue(params.ecoIssueId);
    const nextPolicyVersion = ws.catalog.policy.policyVersion + 1;

    const nextPolicy: VerificationPolicy =
      params.mode === "DEMO_SOLO_ADMIN"
        ? {
            policyId: "POL-HELIOS-SOLO-EVALUATOR",
            policyVersion: nextPolicyVersion,
            requiredAttestationRoles: ["Administrators"],
            carryForwardDispositionRole: "Administrators",
            enforceSeparationOfDuties: false,
            allowRuleBasedCarryForward: true
          }
        : {
            policyId: "POL-HELIOS-2026",
            policyVersion: nextPolicyVersion,
            requiredAttestationRoles: ["Lead Engineers", "Quality Approvers"],
            carryForwardDispositionRole: "Power Electronics Disposition Authority",
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
    const trustedRoles = await this.jira.fetchProjectRoleMembers(params.projectKey, requiredRoles);
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
        if (this.store.isRegisteredEvidenceIssue) {
          const isChildEvidenceTicket = await this.store.isRegisteredEvidenceIssue(
            params.ecoIssueId
          );
          if (isChildEvidenceTicket) {
            return { result: true };
          }
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
  }) {
    await this.ensureProvisionedOrThrow();
    const ws = await this.mustLoadWorkspace(params.ecoIssueId);
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
    switch (presetId) {
      case "BASELINE":
        return [];
      case "CAP_REV_C_ALL_5000":
        return buildHeliosCapRevCSubstitution(catalog, "ALL", 5000);
      case "CAP_REV_C_400V_5000":
        return buildHeliosCapRevCSubstitution(catalog, ["VAR_400V"], 5000);
      case "COLD_SOAK_MINUS_40C":
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
      case "SEAL_REV_B_3000":
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
    const safeSerial =
      Number.isSafeInteger(req.kind === "AMBIENT_ENVELOPE_SHIFT" ? 1000 : req.serialFrom) &&
      (req.kind === "AMBIENT_ENVELOPE_SHIFT" || req.serialFrom >= 1000)
        ? req.kind === "AMBIENT_ENVELOPE_SHIFT"
          ? 1000
          : req.serialFrom
        : 5000;

    if (req.kind === "CAP_REV_C_CUTOVER") {
      return buildHeliosCapRevCSubstitution(catalog, req.targetVariants, safeSerial);
    }
    if (req.kind === "SEAL_REV_B_CUTOVER") {
      return buildSerialScopedSubstitutionOps({
        currentEdges: catalog.baselineBomEdges,
        allVariantIds: catalog.variants.map((v) => v.variantId),
        parentItemRevId: "PACK-HELIOS@A",
        slotKey: "ENCLOSURE_SEAL_S1",
        newChildItemRevId: "SEAL-EPDM@B",
        newEdgeIdPrefix: "E-CF-SEAL",
        targetVariants: req.targetVariants,
        serialFrom: safeSerial,
        serialTo: null
      });
    }
    const targetVar = catalog.variants.find((v) => v.variantId === req.variantId);
    const baseBusV = targetVar?.operatingEnvelope["bus_voltage"] ?? qty(400, 0, "V");
    const baseAuxV = targetVar?.operatingEnvelope["aux_rail_voltage"] ?? qty(12, 0, "V");
    return [
      {
        op: "SET_VARIANT_ENVELOPE",
        variantId: req.variantId,
        operatingEnvelope: {
          bus_voltage: baseBusV,
          max_ambient: qty(Math.trunc(req.maxAmbientC), 0, "degC"),
          min_ambient: qty(Math.trunc(req.minAmbientC), 0, "degC"),
          aux_rail_voltage: baseAuxV
        }
      }
    ];
  }

  private async fetchLiveVerificationContext(
    projectKey: string,
    ws: StoredEcoWorkspace,
    cachedRoles?: Record<string, readonly string[]>
  ): Promise<{
    readonly liveEco: LiveJiraIssueProjection;
    readonly trustedRoles: Record<string, readonly string[]>;
    readonly liveIssuesById: Record<string, LiveJiraIssueProjection>;
  }> {
    const uniqueEvidenceIssueIds = [
      ...new Set(ws.catalog.evidenceRecords.map((ev) => ev.jiraIssueId))
    ];

    const [liveEco, trustedRoles, ...liveEvidenceList] = await Promise.all([
      this.jira.fetchLiveIssue(ws.ecoIssueId),
      cachedRoles
        ? Promise.resolve(cachedRoles)
        : this.jira.fetchProjectRoleMembers(projectKey, this.collectAllPossibleRoles(ws.catalog)),
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
    overrideEcoStatusCategoryKey?: string
  ): Promise<{
    readonly evaluation: VerificationEvaluation;
    readonly evidenceIntegrity: readonly LiveEvidenceIntegrityRow[];
  }> {
    const { liveEco, trustedRoles, liveIssuesById } = await this.fetchLiveVerificationContext(
      projectKey,
      ws,
      cachedRoles
    );

    const effectiveStatus = overrideEcoStatusCategoryKey ?? liveEco.statusCategoryKey;

    const evaluation = verifyEngineeringChange({
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
    });

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

    return { evaluation, evidenceIntegrity };
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
