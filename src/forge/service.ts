import { randomUUID } from "node:crypto";
import { verifyEngineeringChange } from "../core/verifier";
import type {
  ChangeOperation,
  EcoMetadata,
  FamilyCatalog,
  FinalizedReleaseReceipt,
  LiveJiraIssueProjection,
  PendingTransitionIntent,
  RoleAttestation,
  VerificationEvaluation
} from "../core/types";
import {
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
  type EcoWorkspaceView,
  type JiraPlatformGateway,
  type ProvisioningStatusReport,
  type StoredEcoWorkspace,
  type VerificationStore
} from "./ports";
import type { SqlProvisioningManager } from "./provisioning";

export const DEFAULT_PENDING_INTENT_TTL_MS = 120_000;

export interface WorkflowValidatorResponse {
  readonly result: boolean;
  readonly errorMessage?: string;
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
  }): Promise<EcoWorkspaceView> {
    const provisioning = await this.provisioning.inspectStatus();
    if (provisioning.state !== "READY") {
      return { provisioning, workspace: null, evaluation: null };
    }

    const workspace = await this.store.getEcoWorkspace(params.ecoIssueId);
    if (!workspace) {
      return { provisioning, workspace: null, evaluation: null };
    }

    const evaluation = await this.evaluateWorkspaceAgainstLiveJira(params.projectKey, workspace);
    return { provisioning, workspace, evaluation };
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
   * Commits a new set of proposed operations via conditional CAS (`revisionSeq + 1`) AND
   * strictly increments `eco.approvalGeneration` (`approvalGeneration + 1`).
   *
   * Issue #2: Even if `proposedOperations` restores exact engineering state back to an earlier
   * SHA-256 digest `H1` (`H1 -> H2 -> H1`), incrementing `approvalGeneration` deterministically
   * invalidates all prior attestations signed at generation 1.
   */
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

  /**
   * Records a human role attestation bound to `(snapshotSha256, approvalGeneration, policyVersion)`.
   * Never trusts client-supplied signer identity; `signerAccountId` must come from Forge context.
   */
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
      throw new AuthorizationError("Authenticated Atlassian accountId is required to sign an attestation.");
    }
    if (!params.rationale.trim()) {
      throw new AuthorizationError("Non-empty engineering rationale is required for role attestation.");
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

  /**
   * Issue #3 (Phase 1 — Pre-Transition Validator):
   * Executes synchronously inside `jira:workflowValidator` BEFORE Jira commits the transition.
   *
   * Bounded honesty guarantees:
   * 1. Fails closed (`result: false`) if SQL provisioning is not READY, workspace is missing,
   *    any slice obligation is invalidated/indeterminate/incomplete, or required attestations
   *    for `(snapshotSha256, approvalGeneration, policyVersion)` are missing.
   * 2. Writes ONLY a bounded-TTL `PendingTransitionIntent` via CAS (`revisionSeq + 1`), NEVER
   *    a `FinalizedReleaseReceipt`, because Jira may still abort the transition downstream.
   * 3. Cannot prevent Jira from committing if an edit races inside `[t_validator_return, t_jira_commit]`;
   *    that residual TOCTOU window is detected deterministically in Phase 2 (`reconcileIssueUpdatedEvent`).
   */
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

  /**
   * Issue #3 (Phase 2 — Post-Transition Reconciliation on `avi:jira:updated:issue`):
   * - If Jira aborted the transition (ECO status category != "done"), never promotes `PendingTransitionIntent`.
   * - If ECO status category == "done", promotes `PendingTransitionIntent` to `FinalizedReleaseReceipt`
   *   ONLY IF the intent is unexpired AND live `(snapshotSha256, approvalGeneration, policyVersion)` and
   *   all gate invariants still hold.
   * - Otherwise (unprotected workflow route, mid-transition TOCTOU mutation, or post-release drift),
   *   atomically flags `unvalidatedDriftDetected = true` (`UNVALIDATED_RELEASE_DRIFT`).
   */
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

    // ECO is in Done category: check if already finalized and still matching live state
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

    // Unprotected transition, TOCTOU mutation during transition, or post-release evidence drift!
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

  private async evaluateWorkspaceAgainstLiveJira(
    projectKey: string,
    ws: StoredEcoWorkspace,
    cachedRoles?: Record<string, readonly string[]>,
    overrideEcoStatusCategoryKey?: string
  ): Promise<VerificationEvaluation> {
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

    const effectiveStatus = overrideEcoStatusCategoryKey ?? liveEco.statusCategoryKey;

    return verifyEngineeringChange({
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
