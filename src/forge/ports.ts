import type {
  BaselineSliceObligationResult
} from "../core/baselines";
import type {
  ChangeOperation,
  EcoGateState,
  EcoMetadata,
  FamilyCatalog,
  FinalizedReleaseReceipt,
  ItemRevision,
  LiveJiraIssueProjection,
  PendingTransitionIntent,
  RoleAttestation,
  VerificationEvaluation
} from "../core/types";
import type { IndustryTemplateId } from "../scenarios/industryTemplates";

export type { IndustryTemplateId };

export type ProvisioningState =
  | "UNPROVISIONED"
  | "PROVISIONING_IN_PROGRESS"
  | "READY"
  | "PROVISIONING_FAILED";

export interface ProvisioningStatusReport {
  readonly state: ProvisioningState;
  readonly appliedMigrations: readonly string[];
  readonly pendingMigrations: readonly string[];
  readonly lastAttemptAtEpochMs: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export interface StoredEcoWorkspace {
  readonly ecoIssueId: string;
  /** Optimistic CAS sequence incremented on every storage write */
  readonly revisionSeq: number;
  readonly updatedAtEpochMs: number;
  readonly catalog: FamilyCatalog;
  readonly eco: EcoMetadata;
  readonly proposedOperations: readonly ChangeOperation[];
  readonly attestations: readonly RoleAttestation[];
  readonly pendingTransitionIntent: PendingTransitionIntent | null;
  readonly finalizedReleaseReceipt: FinalizedReleaseReceipt | null;
  readonly unvalidatedDriftDetected: boolean;
}

/** Durable, per-ECO state machine; intentionally separate from release snapshots. */
export type EvidenceSlotStage = "CREATING" | "CREATED" | "DONE" | "LINKED";
export interface EvidenceProvisioningSlot {
  readonly evidenceId: string;
  readonly operationId: string;
  readonly stage: EvidenceSlotStage;
  readonly jiraIssueId?: string;
  readonly jiraIssueKey?: string;
}

export interface EvidenceProvisioningLedger {
  readonly ecoIssueId: string;
  readonly ecoIssueKey: string;
  readonly projectKey: string;
  readonly templateId: IndustryTemplateId;
  readonly ownerId: string;
  readonly leaseUntilEpochMs: number;
  readonly status: "IN_PROGRESS" | "FAILED" | "COMPLETE";
  readonly slots: Readonly<Record<string, EvidenceProvisioningSlot>>;
  /** TiDB compare-and-swap revision, unrelated to the ECO approval generation. */
  readonly revisionSeq: number;
}

export interface CreateEvidenceSlotCallbacks {
  readonly onCreated: (issueId: string, issueKey: string) => Promise<void>;
  readonly onDone: () => Promise<void>;
  readonly onLinked: () => Promise<void>;
}

export interface ProjectGovernanceConfig {
  readonly projectKey: string;
  readonly governedIssueTypeIds: readonly string[];
  readonly updatedByAccountId: string;
  readonly updatedAtEpochMs: number;
  readonly revisionSeq: number;
}

export interface VerificationStore {
  getEcoWorkspace(ecoIssueId: string): Promise<StoredEcoWorkspace | null>;
  listEcoWorkspaces?(): Promise<readonly StoredEcoWorkspace[]>;
  insertInitialEcoWorkspace(
    workspace: Omit<StoredEcoWorkspace, "revisionSeq">
  ): Promise<StoredEcoWorkspace>;
  casUpdateEcoWorkspace(
    expectedRevisionSeq: number,
    nextWorkspace: Omit<StoredEcoWorkspace, "revisionSeq">
  ): Promise<StoredEcoWorkspace>;
  registerEvidenceIssueIds?(issueIds: readonly string[]): Promise<void>;
  isRegisteredEvidenceIssue?(issueId: string): Promise<boolean>;
  getProvisioningLedger?(ecoIssueId: string): Promise<EvidenceProvisioningLedger | null>;
  insertProvisioningLedger?(
    ledger: Omit<EvidenceProvisioningLedger, "revisionSeq">
  ): Promise<EvidenceProvisioningLedger>;
  casProvisioningLedger?(
    expectedRevisionSeq: number,
    ledger: Omit<EvidenceProvisioningLedger, "revisionSeq">
  ): Promise<EvidenceProvisioningLedger>;
  getProjectGovernanceConfig?(projectKey: string): Promise<ProjectGovernanceConfig | null>;
  insertProjectGovernanceConfig?(
    config: Omit<ProjectGovernanceConfig, "revisionSeq">
  ): Promise<ProjectGovernanceConfig>;
  casProjectGovernanceConfig?(
    expectedRevisionSeq: number,
    config: Omit<ProjectGovernanceConfig, "revisionSeq">
  ): Promise<ProjectGovernanceConfig>;
}

export interface ConnectivityProbeResult {
  readonly ok: boolean;
  readonly checkedAtEpochMs: number;
  readonly callerAccountId: string | null;
  readonly callerDisplayName: string | null;
  readonly jiraServerBaseUrl: string | null;
  readonly jiraDeploymentType: string | null;
  readonly issueReachable: boolean;
  readonly resolvedRoleCount: number;
  readonly diagnostics: readonly string[];
}

export interface VerificationIssueSeedSpec {
  readonly evidenceId: string;
  readonly summary: string;
  readonly description: string;
}

export interface ProvisionedVerificationIssue {
  readonly evidenceId: string;
  readonly liveIssue: LiveJiraIssueProjection;
}

export interface JiraPlatformGateway {
  fetchLiveIssue(issueId: string): Promise<LiveJiraIssueProjection>;
  fetchLiveIssueByKeyOrId(
    issueKeyOrId: string
  ): Promise<LiveJiraIssueProjection & { readonly projectKey: string }>;
  fetchProjectRoleMembers(
    projectKey: string,
    requiredRoles: readonly string[],
    candidateAccountIds?: readonly string[]
  ): Promise<Record<string, readonly string[]>>;
  /** Per-slot recoverable provisioning. Older test adapters may implement bulk only. */
  verifyProvisioningIssueProvenance?(params: {
    readonly issueKeyOrId: string;
    readonly ecoIssueId: string;
    readonly ecoIssueKey: string;
    readonly projectKey: string;
    readonly templateId: IndustryTemplateId;
    readonly evidenceId: string;
    readonly operationId: string;
  }): Promise<{ readonly jiraIssueId: string; readonly jiraIssueKey: string }>;
  provisionVerificationIssueSlot?(params: {
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
  }): Promise<ProvisionedVerificationIssue>;
  provisionVerificationIssues(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly specs: readonly VerificationIssueSeedSpec[];
    readonly onCreatedBeforeTransition?: (createdIssueIds: readonly string[]) => Promise<void>;
  }): Promise<readonly ProvisionedVerificationIssue[]>;
  postIssueComment?(params: {
    readonly issueIdOrKey: string;
    readonly markdownText: string;
  }): Promise<{ readonly commentId: string }>;
  probeConnectivity(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<ConnectivityProbeResult>;
}

export interface LiveEvidenceIntegrityRow {
  readonly evidenceId: string;
  readonly obligationId: string;
  readonly obligationCode: string;
  readonly testedVariantId: string;
  readonly jiraIssueId: string;
  readonly jiraIssueKey: string;
  readonly pinnedIssueStateHash: string;
  readonly liveIssueStateHash: string | null;
  readonly liveSummary: string | null;
  readonly liveStatusCategoryKey: string | null;
  readonly isReachable: boolean;
  readonly statusIsDone: boolean;
  readonly hashMatches: boolean;
}

export interface BaselineTotalsSummary {
  readonly b0Supported: number;
  readonly b1Supported: number;
  readonly b2Supported: number;
  readonly linelockSupported: number;
  readonly totalSliceObligations: number;
}

export interface EcoWorkspaceView {
  readonly callerAccountId?: string;
  readonly provisioning: ProvisioningStatusReport;
  readonly workspace: StoredEcoWorkspace | null;
  readonly evaluation: VerificationEvaluation | null;
  readonly evidenceIntegrity?: readonly LiveEvidenceIntegrityRow[];
  readonly releaseAssuranceMarkdown?: string;
  readonly baselineSummary?: BaselineTotalsSummary;
  /** Live Jira is Done while receipt promotion has not been persisted. */
  readonly reconciliationStatus?: "PENDING_RELEASE_RECONCILIATION";
}

export type ScenarioPresetId =
  | "BASELINE"
  | "CAP_REV_C_ALL_5000"
  | "CAP_REV_C_400V_5000"
  | "COLD_SOAK_MINUS_40C"
  | "SEAL_REV_B_3000";

export type GovernancePolicyMode = "PRODUCTION_MULTI_ROLE" | "DEMO_SOLO_ADMIN";

export type CounterfactualRequest =
  | {
      readonly kind:
        | "CAP_REV_C_CUTOVER"
        | "CAP_REV_D_DRAFT_CUTOVER"
        | "GATE_DRIVER_REV_B_CUTOVER"
        | "SEAL_REV_B_CUTOVER";
      readonly targetVariants: "ALL" | readonly string[];
      readonly serialFrom: number;
      readonly serialTo?: number | null;
    }
  | {
      readonly kind: "AMBIENT_ENVELOPE_SHIFT";
      readonly variantId: string;
      readonly minAmbientC: number;
      readonly maxAmbientC: number;
    };

export interface CounterfactualDeltaSummary {
  readonly currentGateState: string;
  readonly simulatedGateState: string;
  readonly currentSupportedCount: number;
  readonly simulatedSupportedCount: number;
  readonly currentBlockedCount: number;
  readonly simulatedBlockedCount: number;
  readonly currentRequiredRetests: number;
  readonly simulatedRequiredRetests: number;
}

export interface CounterfactualSimulationResult {
  readonly currentEvaluation: VerificationEvaluation;
  readonly simulatedEvaluation: VerificationEvaluation;
  readonly proposedOperations: readonly ChangeOperation[];
  readonly delta: CounterfactualDeltaSummary;
  readonly baselineComparison?: {
    readonly b0: readonly BaselineSliceObligationResult[];
    readonly b1: readonly BaselineSliceObligationResult[];
    readonly b2: readonly BaselineSliceObligationResult[];
  };
}

export interface CustomComponentSubstitutionRequest {
  readonly partNumber: string;
  readonly revision: string;
  readonly title: string;
  readonly specStatus: ItemRevision["specStatus"];
  readonly targetSlotPath: string;
  readonly primaryNumericAttrKey: string;
  readonly primaryNumericValue: number;
  readonly primaryNumericScale: number;
  readonly primaryNumericUnit: string;
  readonly secondaryEnumAttrKey?: string;
  readonly secondaryEnumValue?: string;
  readonly targetVariants: "ALL" | readonly string[];
  readonly serialFrom: number;
  readonly serialTo?: number | null;
}

export interface BindJiraEvidenceRequest {
  readonly evidenceId: string;
  readonly jiraIssueKeyOrId: string;
}

export interface FleetEcoSummaryRow {
  readonly ecoIssueId: string;
  readonly ecoIssueKey: string;
  readonly familyId: string;
  readonly gateState: EcoGateState;
  readonly transitionAllowed: boolean;
  readonly snapshotSha256: string;
  readonly approvalGeneration: number;
  readonly revisionSeq: number;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly sliceCount: number;
  readonly supportedObligations: number;
  readonly totalObligations: number;
  readonly evidencePinHealthyCount: number;
  readonly totalEvidenceCount: number;
  readonly updatedAtEpochMs: number;
}

export interface ProjectFleetOverview {
  readonly projectKey: string;
  readonly provisioning: ProvisioningStatusReport;
  readonly evaluatedAtEpochMs: number;
  readonly totalEcos: number;
  readonly verifiedReleasedCount: number;
  readonly readyCount: number;
  readonly awaitingSignoffCount: number;
  readonly blockedCount: number;
  readonly driftAlertCount: number;
  readonly verdictDistribution: {
    readonly supportedAsTested: number;
    readonly supportedByRule: number;
    readonly invalidated: number;
    readonly indeterminate: number;
  };
  readonly baselineComparisonTotals: BaselineTotalsSummary;
  readonly ecos: readonly FleetEcoSummaryRow[];
}

export class ConcurrentModificationError extends Error {
  public readonly code = "CONCURRENT_MODIFICATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentModificationError";
  }
}

export class StaleSnapshotError extends Error {
  public readonly code = "STALE_SNAPSHOT" as const;
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

export class StaleGenerationError extends Error {
  public readonly code = "STALE_APPROVAL_GENERATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "StaleGenerationError";
  }
}

export class AuthorizationError extends Error {
  public readonly code = "UNAUTHORIZED_ACTOR" as const;
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class ProvisioningNotReadyError extends Error {
  public readonly code = "PROVISIONING_NOT_READY" as const;
  public readonly provisioningState: ProvisioningState;
  constructor(state: ProvisioningState, message: string) {
    super(message);
    this.name = "ProvisioningNotReadyError";
    this.provisioningState = state;
  }
}
