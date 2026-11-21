/**
 * LineLock — Pure Deterministic Verification Kernel Types
 *
 * Trust boundary: ZERO dependencies on Atlassian Forge SDKs, network I/O,
 * browser globals, or wall-clock nondeterminism.
 *
 * Scope boundary: Verifies completeness and applicability of recorded engineering
 * evidence against effective BOM configurations and approved carry-forward rules.
 * Does NOT certify physical product safety or statutory regulatory compliance.
 */

export type ScalarValue =
  | {
      readonly kind: "quantity";
      /** Safe integer mantissa; exact value = mantissa * 10^scale */
      readonly mantissa: number;
      readonly scale: number;
      /** Mandatory canonical unit symbol (e.g. "V", "mOhm", "degC") */
      readonly unit: string;
    }
  | { readonly kind: "enum"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean };

export type TruthValue = "TRUE" | "FALSE" | "UNKNOWN";

export type ValueRef =
  | { readonly source: "slot_attr"; readonly slotPath: string; readonly attrKey: string }
  | { readonly source: "variant_env"; readonly envKey: string }
  | { readonly source: "tested_env"; readonly envKey: string }
  | { readonly source: "literal"; readonly value: ScalarValue };

export type NumericTerm =
  | ValueRef
  | {
      readonly op: "SCALE";
      readonly factorMantissa: number;
      readonly factorScale: number;
      readonly arg: ValueRef;
    }
  | {
      readonly op: "ADD_SUB";
      readonly kind: "ADD" | "SUB";
      readonly left: ValueRef;
      readonly right: ValueRef;
    };

export type PredicateExpr =
  | {
      readonly kind: "CMP_NUM";
      readonly cmp: "EQ" | "LTE" | "LT" | "GTE" | "GT";
      readonly left: NumericTerm;
      readonly right: NumericTerm;
    }
  | {
      readonly kind: "CMP_ENUM";
      readonly cmp: "EQ" | "IN";
      readonly ref: ValueRef;
      readonly allowed: readonly string[];
    }
  | {
      readonly kind: "CMP_BOOL";
      readonly expected: boolean;
      readonly ref: ValueRef;
    }
  | { readonly kind: "AND"; readonly args: readonly PredicateExpr[] }
  | { readonly kind: "OR"; readonly args: readonly PredicateExpr[] }
  | { readonly kind: "NOT"; readonly arg: PredicateExpr };

export interface VerificationPolicy {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly requiredAttestationRoles: readonly string[];
  readonly carryForwardDispositionRole?: string;
  readonly enforceSeparationOfDuties: boolean;
  readonly allowRuleBasedCarryForward: boolean;
}

export interface ProductVariant {
  readonly variantId: string;
  readonly skuCode: string;
  readonly displayName: string;
  readonly operatingEnvelope: Readonly<Record<string, ScalarValue>>;
}

export interface ItemRevision {
  readonly itemRevId: string;
  readonly partNumber: string;
  readonly revision: string;
  readonly title: string;
  readonly itemKind: "ASSEMBLY" | "COMPONENT";
  readonly specStatus: "APPROVED" | "DRAFT" | "OBSOLETE";
  readonly attributes: Readonly<Record<string, ScalarValue>>;
}

export interface BomEffectivityEdge {
  readonly edgeId: string;
  readonly parentItemRevId: string;
  readonly slotKey: string;
  readonly childItemRevId: string;
  readonly variantScope: "ALL" | readonly string[];
  /** Safe integer >= 1 (inclusive) */
  readonly serialFrom: number;
  /** Safe integer > serialFrom (exclusive), or null for +infinity */
  readonly serialTo: number | null;
}

export interface ExcludedSlotDeclaration {
  readonly slotPath: string;
  readonly justification: string;
  readonly approvedByAccountId: string;
}

export interface ExcludedEnvelopeKeyDeclaration {
  readonly envKey: string;
  readonly justification: string;
  readonly approvedByAccountId: string;
}

export interface VerificationObligation {
  readonly obligationId: string;
  readonly code: string;
  readonly title: string;
  readonly applicableVariants: "ALL" | readonly string[];
  readonly carryForwardMode: "RETEST_REQUIRED" | "EXPLICIT_RULE_REQUIRED";
  /**
   * Closed-world BOM dependency partition:
   * Every leaf component slotPath resolved in an effective slice MUST appear in either
   * governedSlotPaths or excludedSlots; any unclassified leaf slot blocks as unexamined.
   */
  readonly governedSlotPaths: readonly string[];
  readonly excludedSlots: readonly ExcludedSlotDeclaration[];
  /**
   * Closed-world operating-condition partition:
   * Every key in variant.operatingEnvelope MUST appear in either governedEnvelopeKeys
   * or excludedEnvelopeKeys, and all governedEnvelopeKeys must be present.
   */
  readonly governedEnvelopeKeys: readonly string[];
  readonly excludedEnvelopeKeys: readonly ExcludedEnvelopeKeyDeclaration[];
}

export interface VerificationEvidence {
  readonly evidenceId: string;
  readonly obligationId: string;
  readonly jiraIssueId: string;
  readonly jiraIssueKey: string;
  readonly pinnedIssueStateHash: string;
  readonly testedVariantId: string;
  /**
   * Complete map of governedSlotPaths -> itemRevId present in the physical test article.
   * Omitting any governedSlotPath causes INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT.
   */
  readonly testedSlotBinding: Readonly<Record<string, string>>;
  /**
   * Complete map of governedEnvelopeKeys -> ScalarValue measured during test execution.
   * Without an approved CarryForwardRule, exact match on all governedEnvelopeKeys is required.
   */
  readonly testedOperatingConditions: Readonly<Record<string, ScalarValue>>;
  readonly recordedOutcome: "PASS" | "FAIL";
  readonly approvalStatus: "APPROVED" | "UNAPPROVED";
}

export interface CarryForwardRule {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly obligationId: string;
  readonly sourceEvidenceId: string;
  readonly approvalStatus: "APPROVED" | "DRAFT" | "REVOKED";
  readonly approvedByAccountId: string;
  /** Closed-world allowlist of governedSlotPaths permitted to differ from testedSlotBinding */
  readonly changeableSlots: readonly string[];
  /** Closed-world allowlist of governedEnvelopeKeys permitted to differ from testedOperatingConditions */
  readonly changeableEnvelopeKeys: readonly string[];
  readonly envelopePredicate: PredicateExpr;
  readonly validityPredicate: PredicateExpr;
  readonly requiresDispositionSignoff: boolean;
}

export interface RetestDominanceRule {
  readonly dominanceRuleId: string;
  readonly obligationId: string;
  readonly approvalStatus: "APPROVED" | "DRAFT" | "REVOKED";
  readonly coveringVariantId: string;
  readonly coveredVariantIds: readonly string[];
}

export type ChangeOperation =
  | { readonly op: "UPSERT_EDGE"; readonly edge: BomEffectivityEdge }
  | { readonly op: "REMOVE_EDGE"; readonly edgeId: string }
  | {
      readonly op: "SET_VARIANT_ENVELOPE";
      readonly variantId: string;
      readonly operatingEnvelope: Readonly<Record<string, ScalarValue>>;
    };

export interface LiveJiraIssueProjection {
  readonly issueId: string;
  readonly issueKey: string;
  readonly summary: string;
  readonly description: string;
  readonly statusCategoryKey: "done" | "indeterminate" | "new" | string;
  readonly resolutionName: string | null;
  readonly updatedAtEpochMs: number;
  readonly structuredFields: Readonly<Record<string, ScalarValue>>;
}

export interface RoleAttestation {
  readonly attestationId: string;
  readonly ecoJiraIssueId: string;
  readonly roleName: string;
  readonly signerAccountId: string;
  readonly attestedSnapshotSha256: string;
  /** Monotonic generation counter preventing ABA (H1 -> H2 -> H1) attestation reuse */
  readonly attestedApprovalGeneration: number;
  readonly attestedPolicyVersion: number;
  readonly rationale: string;
  readonly signedAtEpochMs: number;
}

/**
 * Phase 1 pre-transition intent recorded by jira:workflowValidator before Jira commits
 * the workflow transition. Never treated as a finalized release receipt unless Jira
 * actually reaches Done status while snapshot + generation + policy remain unchanged.
 */
export interface PendingTransitionIntent {
  readonly intentId: string;
  readonly ecoJiraIssueId: string;
  readonly verifiedSnapshotSha256: string;
  readonly verifiedApprovalGeneration: number;
  readonly verifiedPolicyVersion: number;
  readonly actorAccountId: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

/**
 * Phase 2 post-transition receipt promoted only after Jira confirms Done status
 * and live state still matches the PendingTransitionIntent.
 */
export interface FinalizedReleaseReceipt {
  readonly receiptId: string;
  readonly sourceIntentId: string;
  readonly ecoJiraIssueId: string;
  readonly verifiedSnapshotSha256: string;
  readonly verifiedApprovalGeneration: number;
  readonly verifiedPolicyVersion: number;
  readonly finalizedAtEpochMs: number;
}

export interface EcoMetadata {
  readonly ecoJiraIssueId: string;
  readonly ecoJiraKey: string;
  readonly ecoCreatedAtEpochMs: number;
  readonly authorAccountId: string;
  readonly lastEditorAccountId: string;
  /**
   * Strictly monotonic positive integer incremented on EVERY committed proposal,
   * policy, or catalog edit — including edits that revert state back to H1.
   */
  readonly approvalGeneration: number;
  readonly liveEcoStatusCategoryKey?: "done" | "indeterminate" | "new" | string;
}

export interface FamilyCatalog {
  readonly familyId: string;
  readonly rootAssemblyRevId: string;
  readonly policy: VerificationPolicy;
  readonly variants: readonly ProductVariant[];
  readonly itemRevisions: readonly ItemRevision[];
  readonly baselineBomEdges: readonly BomEffectivityEdge[];
  readonly obligations: readonly VerificationObligation[];
  readonly evidenceRecords: readonly VerificationEvidence[];
  readonly carryForwardRules: readonly CarryForwardRule[];
  readonly retestDominanceRules?: readonly RetestDominanceRule[];
}

export interface VerificationInput {
  readonly catalog: FamilyCatalog;
  readonly eco: EcoMetadata;
  readonly proposedOperations: readonly ChangeOperation[];
  readonly liveVerificationIssuesById: Readonly<Record<string, LiveJiraIssueProjection>>;
  readonly attestations: readonly RoleAttestation[];
  readonly trustedRoleMembersByRole: Readonly<Record<string, readonly string[]>>;
  readonly pendingTransitionIntent?: PendingTransitionIntent | null;
  readonly finalizedReleaseReceipt?: FinalizedReleaseReceipt | null;
  readonly unvalidatedDriftDetected?: boolean;
}

export interface SerialInterval {
  readonly serialFrom: number;
  readonly serialTo: number | null;
}

export type SliceStructuralErrorCode =
  | "INVALID_SERIAL_BOUNDS"
  | "CYCLIC_BOM"
  | "OVERLAPPING_EFFECTIVITY"
  | "MISSING_ITEM_REVISION"
  | "UNAPPROVED_ITEM_SPEC";

export interface SliceStructuralDiagnostic {
  readonly code: SliceStructuralErrorCode;
  readonly detail: string;
  readonly slotPath?: string;
}

export interface EffectiveSlice {
  readonly sliceId: string;
  readonly variantId: string;
  readonly interval: SerialInterval;
  /** All resolved structural slotPaths (both intermediate assemblies and leaf components) */
  readonly resolvedSlotBindings: Readonly<Record<string, string>>;
  /** Only leaf COMPONENT structural slotPaths for exhaustive dependency-partition checking */
  readonly leafSlotPaths: readonly string[];
  readonly structuralDiagnostics: readonly SliceStructuralDiagnostic[];
}

export interface PredicateTraceNode {
  readonly exprKind: string;
  readonly value: TruthValue;
  readonly reason: string;
  readonly children?: readonly PredicateTraceNode[];
}

export type SliceObligationStatus =
  | "SUPPORTED_AS_TESTED"
  | "SUPPORTED_BY_APPROVED_RULE"
  | "UNCOVERED_OR_UNEXECUTED"
  | "INVALIDATED_EVIDENCE_DRIFT"
  | "INVALIDATED_UNCOVERED_CHANGE"
  | "INVALIDATED_ENVELOPE_EXCEEDED"
  | "INVALIDATED_PREDICATE_FALSE"
  | "INVALIDATED_RETEST_REQUIRED"
  | "INDETERMINATE_MISSING_DATA"
  | "INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT"
  | "INDETERMINATE_UNEXAMINED_DEPENDENCY"
  | "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION";

export interface SliceObligationEvaluation {
  readonly sliceId: string;
  readonly variantId: string;
  readonly interval: SerialInterval;
  readonly obligationId: string;
  readonly obligationCode: string;
  readonly status: SliceObligationStatus;
  readonly supportingEvidenceId: string | null;
  readonly appliedCarryForwardRuleId: string | null;
  readonly requiresDispositionSignoff: boolean;
  readonly explanation: string;
  readonly changedGovernedSlots: readonly string[];
  readonly changedGovernedEnvelopeKeys: readonly string[];
  readonly changedExcludedSlots: readonly string[];
  readonly envelopeTrace?: PredicateTraceNode;
  readonly validityTrace?: PredicateTraceNode;
}

export type EcoGateState =
  | "BLOCKED_STRUCTURAL"
  | "BLOCKED_INVALIDATED"
  | "BLOCKED_INDETERMINATE"
  | "EVIDENCE_INCOMPLETE"
  | "AWAITING_ATTESTATION"
  | "READY_FOR_RELEASE_TRANSITION"
  | "RELEASE_TRANSITIONED_VERIFIED"
  | "UNVALIDATED_RELEASE_DRIFT";

export interface AttestationStatusSummary {
  readonly requiredRoles: readonly string[];
  readonly satisfiedRoles: readonly string[];
  readonly missingRoles: readonly string[];
  readonly acceptedAttestations: readonly RoleAttestation[];
  readonly rejectedReasons: readonly { readonly attestationId: string; readonly reason: string }[];
}

export interface RemediationCandidateAction {
  readonly candidateId: string;
  readonly obligationId: string;
  readonly obligationCode: string;
  readonly targetVariantId: string;
  readonly targetInterval: SerialInterval;
  readonly requiredSlotBindings: Readonly<Record<string, string>>;
  readonly coveredSliceIds: readonly string[];
  readonly reason: string;
}

export interface ObligationRemediationPlan {
  readonly obligationId: string;
  readonly obligationCode: string;
  readonly unsatisfiedSliceIds: readonly string[];
  readonly solverMode: "EXACT_BOUNDED" | "APPROXIMATE_GREEDY";
  readonly selectedActions: readonly RemediationCandidateAction[];
}

export interface VerificationEvaluation {
  readonly snapshotSha256: string;
  readonly approvalGeneration: number;
  readonly policyVersion: number;
  readonly gateState: EcoGateState;
  readonly transitionAllowed: boolean;
  readonly slices: readonly EffectiveSlice[];
  readonly sliceObligations: readonly SliceObligationEvaluation[];
  readonly attestationSummary: AttestationStatusSummary;
  readonly remediationPlans: readonly ObligationRemediationPlan[];
  readonly blockingReasons: readonly string[];
}

export const qty = (mantissa: number, scale: number, unit: string): ScalarValue => {
  if (!Number.isSafeInteger(mantissa) || !Number.isSafeInteger(scale)) {
    throw new RangeError(`Quantity mantissa (${mantissa}) and scale (${scale}) must be safe integers.`);
  }
  if (!unit || unit.trim() !== unit) {
    throw new RangeError(`Quantity unit must be a non-empty canonical symbol, got "${unit}".`);
  }
  return { kind: "quantity", mantissa, scale, unit };
};

export const enumVal = (value: string): ScalarValue => ({ kind: "enum", value });
export const boolVal = (value: boolean): ScalarValue => ({ kind: "boolean", value });
