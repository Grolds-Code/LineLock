import type {
  BaselineSliceObligationResult
} from "../core/baselines";
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

export interface VerificationStore {
  getEcoWorkspace(ecoIssueId: string): Promise<StoredEcoWorkspace | null>;
  insertInitialEcoWorkspace(
    workspace: Omit<StoredEcoWorkspace, "revisionSeq">
  ): Promise<StoredEcoWorkspace>;
  casUpdateEcoWorkspace(
    expectedRevisionSeq: number,
    nextWorkspace: Omit<StoredEcoWorkspace, "revisionSeq">
  ): Promise<StoredEcoWorkspace>;
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
    requiredRoles: readonly string[]
  ): Promise<Record<string, readonly string[]>>;
  provisionVerificationIssues(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly specs: readonly VerificationIssueSeedSpec[];
  }): Promise<readonly ProvisionedVerificationIssue[]>;
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

export interface EcoWorkspaceView {
  readonly callerAccountId?: string;
  readonly provisioning: ProvisioningStatusReport;
  readonly workspace: StoredEcoWorkspace | null;
  readonly evaluation: VerificationEvaluation | null;
  readonly evidenceIntegrity?: readonly LiveEvidenceIntegrityRow[];
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
      readonly kind: "CAP_REV_C_CUTOVER";
      readonly targetVariants: "ALL" | readonly string[];
      readonly serialFrom: number;
    }
  | {
      readonly kind: "SEAL_REV_B_CUTOVER";
      readonly targetVariants: "ALL" | readonly string[];
      readonly serialFrom: number;
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
