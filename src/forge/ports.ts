import type {
  ChangeOperation,
  EcoMetadata,
  FamilyCatalog,
  FinalizedReleaseReceipt,
  LiveJiraIssueProjection,
  PendingTransitionIntent,
  RoleAttestation,
  VerificationEvaluation
} from "../core/types.js";

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

export interface JiraPlatformGateway {
  fetchLiveIssue(issueId: string): Promise<LiveJiraIssueProjection>;
  fetchProjectRoleMembers(
    projectKey: string,
    requiredRoles: readonly string[]
  ): Promise<Record<string, readonly string[]>>;
  probeConnectivity(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<ConnectivityProbeResult>;
}

export interface EcoWorkspaceView {
  readonly provisioning: ProvisioningStatusReport;
  readonly workspace: StoredEcoWorkspace | null;
  readonly evaluation: VerificationEvaluation | null;
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
