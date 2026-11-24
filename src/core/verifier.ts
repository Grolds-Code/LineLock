import { computePinnedIssueStateHash, computeSnapshotSha256 } from "./canonical";
import { formatInterval, resolveEffectiveSlices } from "./intervals";
import { evaluatePredicateK3, scalarsExactEqual } from "./predicates";
import { computeRemediationPlans } from "./remediation";
import type {
  AttestationStatusSummary,
  CarryForwardRule,
  EcoGateState,
  EffectiveSlice,
  FamilyCatalog,
  ItemRevision,
  LiveJiraIssueProjection,
  ProductVariant,
  RoleAttestation,
  SliceObligationEvaluation,
  SliceObligationStatus,
  VerificationEvaluation,
  VerificationEvidence,
  VerificationInput,
  VerificationObligation
} from "./types";

function obligationAppliesToVariant(obl: VerificationObligation, variantId: string): boolean {
  return obl.applicableVariants === "ALL" || obl.applicableVariants.includes(variantId);
}

/**
 * Issue #1 & #5: Verifies that the obligation's declared dependency & operating-condition
 * partitions cover 100% of resolved leaf BOM slots and variant operatingEnvelope keys,
 * preventing silent omission of newly added or unexamined dependencies.
 */
function checkObligationPartitionCompleteness(params: {
  readonly slice: EffectiveSlice;
  readonly variant: ProductVariant;
  readonly obligation: VerificationObligation;
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status:
        | "INDETERMINATE_UNEXAMINED_DEPENDENCY"
        | "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION";
      readonly reason: string;
    } {
  const { slice, variant, obligation } = params;

  const governedSlots = new Set<string>(obligation.governedSlotPaths);
  const justifiedExcludedSlots = new Set<string>(
    obligation.excludedSlots
      .filter((e) => e.justification.trim().length > 0 && e.approvedByAccountId.trim().length > 0)
      .map((e) => e.slotPath)
  );

  // Overlap between governed and excluded is an invalid partition
  for (const g of governedSlots) {
    if (justifiedExcludedSlots.has(g)) {
      return {
        ok: false,
        status: "INDETERMINATE_UNEXAMINED_DEPENDENCY",
        reason: `Obligation "${obligation.code}" declares slot "${g}" in both governedSlotPaths and excludedSlots.`
      };
    }
    if (!(g in slice.resolvedSlotBindings)) {
      return {
        ok: false,
        status: "INDETERMINATE_UNEXAMINED_DEPENDENCY",
        reason: `Governed slot "${g}" required by obligation "${obligation.code}" is missing from effective slice.`
      };
    }
  }

  const unexaminedLeafSlots = slice.leafSlotPaths.filter(
    (leaf) => !governedSlots.has(leaf) && !justifiedExcludedSlots.has(leaf)
  );
  if (unexaminedLeafSlots.length > 0) {
    return {
      ok: false,
      status: "INDETERMINATE_UNEXAMINED_DEPENDENCY",
      reason: `Unexamined BOM leaf slot(s) [${unexaminedLeafSlots.join(", ")}] are neither governed nor explicitly excluded with approved justification for "${obligation.code}".`
    };
  }

  const governedEnv = new Set<string>(obligation.governedEnvelopeKeys);
  const excludedEnv = new Set<string>(
    obligation.excludedEnvelopeKeys
      .filter((e) => e.justification.trim().length > 0 && e.approvedByAccountId.trim().length > 0)
      .map((e) => e.envKey)
  );

  for (const gk of governedEnv) {
    if (excludedEnv.has(gk)) {
      return {
        ok: false,
        status: "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION",
        reason: `Envelope key "${gk}" appears in both governedEnvelopeKeys and excludedEnvelopeKeys for "${obligation.code}".`
      };
    }
    if (!(gk in variant.operatingEnvelope)) {
      return {
        ok: false,
        status: "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION",
        reason: `Variant "${variant.variantId}" omits governed operating condition "${gk}" required by "${obligation.code}".`
      };
    }
  }

  const variantEnvKeys = Object.keys(variant.operatingEnvelope).sort();
  const unexaminedEnvKeys = variantEnvKeys.filter(
    (k) => !governedEnv.has(k) && !excludedEnv.has(k)
  );
  if (unexaminedEnvKeys.length > 0) {
    return {
      ok: false,
      status: "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION",
      reason: `Variant "${variant.variantId}" introduces unexamined operating condition(s) [${unexaminedEnvKeys.join(", ")}] not classified for "${obligation.code}".`
    };
  }

  return { ok: true };
}

/**
 * Issue #1 & #5: Verifies that a VerificationEvidence record binds 100% of governedSlotPaths
 * and 100% of governedEnvelopeKeys. Partial testedSlotBinding or partial testedOperatingConditions
 * is deterministically rejected as INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT.
 */
function checkEvidenceFootprintCompleteness(
  ev: VerificationEvidence,
  obligation: VerificationObligation
): { readonly complete: true } | { readonly complete: false; readonly reason: string } {
  const missingSlots = obligation.governedSlotPaths.filter(
    (slotPath) => !(slotPath in ev.testedSlotBinding)
  );
  if (missingSlots.length > 0) {
    return {
      complete: false,
      reason: `Evidence "${ev.evidenceId}" (${ev.jiraIssueKey}) has incomplete footprint: missing governed slot(s) [${missingSlots.join(", ")}].`
    };
  }

  const missingEnvKeys = obligation.governedEnvelopeKeys.filter(
    (envKey) => !(envKey in ev.testedOperatingConditions)
  );
  if (missingEnvKeys.length > 0) {
    return {
      complete: false,
      reason: `Evidence "${ev.evidenceId}" (${ev.jiraIssueKey}) has incomplete operating footprint: missing governed condition(s) [${missingEnvKeys.join(", ")}].`
    };
  }

  return { complete: true };
}

function checkLiveEvidenceIntegrity(
  ev: VerificationEvidence,
  liveIssuesById: Readonly<Record<string, LiveJiraIssueProjection>>
): { readonly valid: true } | { readonly valid: false; readonly drift: boolean; readonly reason: string } {
  if (ev.approvalStatus !== "APPROVED") {
    return {
      valid: false,
      drift: false,
      reason: `Evidence "${ev.evidenceId}" (${ev.jiraIssueKey}) has approvalStatus="${ev.approvalStatus}"`
    };
  }
  if (ev.recordedOutcome !== "PASS") {
    return {
      valid: false,
      drift: false,
      reason: `Evidence "${ev.evidenceId}" (${ev.jiraIssueKey}) recorded outcome="${ev.recordedOutcome}"`
    };
  }
  const live = liveIssuesById[ev.jiraIssueId];
  if (!live) {
    return {
      valid: false,
      drift: true,
      reason: `Linked Jira verification issue "${ev.jiraIssueKey}" (id=${ev.jiraIssueId}) is missing or inaccessible`
    };
  }
  if (live.statusCategoryKey.toLowerCase() !== "done") {
    return {
      valid: false,
      drift: true,
      reason: `Linked Jira issue "${ev.jiraIssueKey}" statusCategory is "${live.statusCategoryKey}" (expected "done")`
    };
  }
  const liveHash = computePinnedIssueStateHash(live, ev.hashProjectionVersion ?? 1);
  if (liveHash !== ev.pinnedIssueStateHash) {
    return {
      valid: false,
      drift: true,
      reason: `Linked Jira issue "${ev.jiraIssueKey}" content/fields drifted from pinned approval hash`
    };
  }
  return { valid: true };
}

const STATUS_PRECEDENCE: Readonly<Record<SliceObligationStatus, number>> = {
  SUPPORTED_AS_TESTED: 100,
  SUPPORTED_BY_APPROVED_RULE: 90,
  INDETERMINATE_UNEXAMINED_DEPENDENCY: 60,
  INDETERMINATE_UNEXAMINED_OPERATING_CONDITION: 58,
  INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT: 55,
  INDETERMINATE_MISSING_DATA: 50,
  INVALIDATED_EVIDENCE_DRIFT: 45,
  INVALIDATED_PREDICATE_FALSE: 40,
  INVALIDATED_ENVELOPE_EXCEEDED: 35,
  INVALIDATED_UNCOVERED_CHANGE: 30,
  INVALIDATED_RETEST_REQUIRED: 25,
  UNCOVERED_OR_UNEXECUTED: 10
};

function evaluateObligationOnSlice(params: {
  readonly catalog: FamilyCatalog;
  readonly slice: EffectiveSlice;
  readonly variant: ProductVariant;
  readonly obligation: VerificationObligation;
  readonly itemsById: ReadonlyMap<string, ItemRevision>;
  readonly liveIssuesById: Readonly<Record<string, LiveJiraIssueProjection>>;
  readonly baselineVariantBindings?: Readonly<Record<string, string>>;
}): SliceObligationEvaluation {
  const {
    catalog,
    slice,
    variant,
    obligation,
    itemsById,
    liveIssuesById,
    baselineVariantBindings
  } = params;

  const changedExcludedSlots = obligation.excludedSlots
    .map((e) => e.slotPath)
    .filter(
      (p) =>
        baselineVariantBindings !== undefined &&
        slice.resolvedSlotBindings[p] !== baselineVariantBindings[p]
    )
    .sort();

  // Step 1: Closed-world dependency & operating-condition partition check
  const partitionCheck = checkObligationPartitionCompleteness({ slice, variant, obligation });
  if (!partitionCheck.ok) {
    return {
      sliceId: slice.sliceId,
      variantId: slice.variantId,
      interval: slice.interval,
      obligationId: obligation.obligationId,
      obligationCode: obligation.code,
      status: partitionCheck.status,
      supportingEvidenceId: null,
      appliedCarryForwardRuleId: null,
      requiresDispositionSignoff: false,
      explanation: partitionCheck.reason,
      changedGovernedSlots: [],
      changedGovernedEnvelopeKeys: [],
      changedExcludedSlots
    };
  }

  const candidates = catalog.evidenceRecords.filter(
    (e) => e.obligationId === obligation.obligationId
  );

  if (candidates.length === 0) {
    return {
      sliceId: slice.sliceId,
      variantId: slice.variantId,
      interval: slice.interval,
      obligationId: obligation.obligationId,
      obligationCode: obligation.code,
      status: "UNCOVERED_OR_UNEXECUTED",
      supportingEvidenceId: null,
      appliedCarryForwardRuleId: null,
      requiresDispositionSignoff: false,
      explanation: `No verification evidence linked to obligation "${obligation.code}".`,
      changedGovernedSlots: [],
      changedGovernedEnvelopeKeys: [],
      changedExcludedSlots
    };
  }

  const orderedCandidates = [...candidates].sort((a, b) => {
    const aSame = a.testedVariantId === variant.variantId ? 0 : 1;
    const bSame = b.testedVariantId === variant.variantId ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    return a.evidenceId.localeCompare(b.evidenceId);
  });

  let bestAttempt: SliceObligationEvaluation | null = null;
  let bestIsSameVariant = false;

  const consider = (candidateEval: SliceObligationEvaluation, isSameVariant: boolean): void => {
    const candSupported =
      candidateEval.status === "SUPPORTED_AS_TESTED" ||
      candidateEval.status === "SUPPORTED_BY_APPROVED_RULE";
    if (bestAttempt === null) {
      bestAttempt = candidateEval;
      bestIsSameVariant = isSameVariant;
      return;
    }
    if (!candSupported && bestIsSameVariant && !isSameVariant) {
      return;
    }
    if (
      (isSameVariant && !bestIsSameVariant) ||
      STATUS_PRECEDENCE[candidateEval.status] > STATUS_PRECEDENCE[bestAttempt.status]
    ) {
      bestAttempt = candidateEval;
      bestIsSameVariant = isSameVariant;
    }
  };

  for (const ev of orderedCandidates) {
    const isSameVariant = ev.testedVariantId === variant.variantId;

    // Step 2: Live Jira issue & approval hash integrity check
    const integrity = checkLiveEvidenceIntegrity(ev, liveIssuesById);
    if (!integrity.valid) {
      consider(
        {
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obligation.obligationId,
          obligationCode: obligation.code,
          status: integrity.drift ? "INVALIDATED_EVIDENCE_DRIFT" : "UNCOVERED_OR_UNEXECUTED",
          supportingEvidenceId: ev.evidenceId,
          appliedCarryForwardRuleId: null,
          requiresDispositionSignoff: false,
          explanation: integrity.reason,
          changedGovernedSlots: [],
          changedGovernedEnvelopeKeys: [],
          changedExcludedSlots
        },
        isSameVariant
      );
      continue;
    }

    // Step 3: Complete evidence footprint check over governedSlotPaths & governedEnvelopeKeys
    const footprint = checkEvidenceFootprintCompleteness(ev, obligation);
    if (!footprint.complete) {
      consider(
        {
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obligation.obligationId,
          obligationCode: obligation.code,
          status: "INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT",
          supportingEvidenceId: ev.evidenceId,
          appliedCarryForwardRuleId: null,
          requiresDispositionSignoff: false,
          explanation: footprint.reason,
          changedGovernedSlots: [],
          changedGovernedEnvelopeKeys: [],
          changedExcludedSlots
        },
        isSameVariant
      );
      continue;
    }

    // Step 4: Exact comparison on all governed slots and all governed operating conditions
    const changedGovernedSlots = obligation.governedSlotPaths
      .filter((p) => slice.resolvedSlotBindings[p] !== ev.testedSlotBinding[p])
      .sort();

    const changedGovernedEnvelopeKeys = obligation.governedEnvelopeKeys
      .filter((k) => !scalarsExactEqual(variant.operatingEnvelope[k], ev.testedOperatingConditions[k]))
      .sort();

    if (changedGovernedSlots.length === 0 && changedGovernedEnvelopeKeys.length === 0) {
      return {
        sliceId: slice.sliceId,
        variantId: slice.variantId,
        interval: slice.interval,
        obligationId: obligation.obligationId,
        obligationCode: obligation.code,
        status: "SUPPORTED_AS_TESTED",
        supportingEvidenceId: ev.evidenceId,
        appliedCarryForwardRuleId: null,
        requiresDispositionSignoff: false,
        explanation:
          changedExcludedSlots.length > 0
            ? `Exact match on all governed slots & conditions via "${ev.evidenceId}" (${ev.jiraIssueKey}); changed non-interfering slot(s) [${changedExcludedSlots.join(", ")}] explicitly excluded.`
            : `Exact match on all governed slots and tested operating conditions via "${ev.evidenceId}" (${ev.jiraIssueKey}).`,
        changedGovernedSlots: [],
        changedGovernedEnvelopeKeys: [],
        changedExcludedSlots
      };
    }

    // Step 5: Divergence requires rule-based carry-forward to be permitted and an APPROVED rule
    if (
      !catalog.policy.allowRuleBasedCarryForward ||
      obligation.carryForwardMode === "RETEST_REQUIRED"
    ) {
      consider(
        {
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obligation.obligationId,
          obligationCode: obligation.code,
          status:
            changedGovernedSlots.length === 0 && changedGovernedEnvelopeKeys.length > 0
              ? "INVALIDATED_ENVELOPE_EXCEEDED"
              : "INVALIDATED_RETEST_REQUIRED",
          supportingEvidenceId: ev.evidenceId,
          appliedCarryForwardRuleId: null,
          requiresDispositionSignoff: false,
          explanation:
            changedGovernedSlots.length === 0
              ? `Same-revision operating condition(s) [${changedGovernedEnvelopeKeys.join(", ")}] differ from tested conditions on "${ev.evidenceId}" and carry-forward is disallowed.`
              : `Obligation "${obligation.code}" requires retest on governed slot change(s): [${changedGovernedSlots.join(", ")}].`,
          changedGovernedSlots,
          changedGovernedEnvelopeKeys,
          changedExcludedSlots
        },
        isSameVariant
      );
      continue;
    }

    const approvedRules: readonly CarryForwardRule[] = catalog.carryForwardRules
      .filter(
        (r) =>
          r.obligationId === obligation.obligationId &&
          r.sourceEvidenceId === ev.evidenceId &&
          r.approvalStatus === "APPROVED"
      )
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));

    if (approvedRules.length === 0) {
      consider(
        {
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obligation.obligationId,
          obligationCode: obligation.code,
          status:
            changedGovernedSlots.length === 0 && changedGovernedEnvelopeKeys.length > 0
              ? "INVALIDATED_ENVELOPE_EXCEEDED"
              : "UNCOVERED_OR_UNEXECUTED",
          supportingEvidenceId: ev.evidenceId,
          appliedCarryForwardRuleId: null,
          requiresDispositionSignoff: false,
          explanation:
            changedGovernedSlots.length === 0
              ? `Operating condition(s) [${changedGovernedEnvelopeKeys.join(", ")}] differ from "${ev.evidenceId}" with no approved CarryForwardRule.`
              : `Changed governed slot(s) [${changedGovernedSlots.join(", ")}] relative to "${ev.evidenceId}" have no approved CarryForwardRule.`,
          changedGovernedSlots,
          changedGovernedEnvelopeKeys,
          changedExcludedSlots
        },
        isSameVariant
      );
      continue;
    }

    for (const rule of approvedRules) {
      const allowedSlots = new Set(rule.changeableSlots);
      const uncoveredSlots = changedGovernedSlots.filter((s) => !allowedSlots.has(s));
      if (uncoveredSlots.length > 0) {
        consider(
          {
            sliceId: slice.sliceId,
            variantId: slice.variantId,
            interval: slice.interval,
            obligationId: obligation.obligationId,
            obligationCode: obligation.code,
            status: "INVALIDATED_UNCOVERED_CHANGE",
            supportingEvidenceId: ev.evidenceId,
            appliedCarryForwardRuleId: rule.ruleId,
            requiresDispositionSignoff: false,
            explanation: `Rule "${rule.ruleId}" does not authorize changing governed slot(s): [${uncoveredSlots.join(", ")}].`,
            changedGovernedSlots,
            changedGovernedEnvelopeKeys,
            changedExcludedSlots
          },
          isSameVariant
        );
        continue;
      }

      const allowedEnvKeys = new Set(rule.changeableEnvelopeKeys);
      const uncoveredEnvKeys = changedGovernedEnvelopeKeys.filter((k) => !allowedEnvKeys.has(k));
      if (uncoveredEnvKeys.length > 0) {
        consider(
          {
            sliceId: slice.sliceId,
            variantId: slice.variantId,
            interval: slice.interval,
            obligationId: obligation.obligationId,
            obligationCode: obligation.code,
            status: "INVALIDATED_ENVELOPE_EXCEEDED",
            supportingEvidenceId: ev.evidenceId,
            appliedCarryForwardRuleId: rule.ruleId,
            requiresDispositionSignoff: false,
            explanation: `Rule "${rule.ruleId}" does not authorize changing operating condition(s): [${uncoveredEnvKeys.join(", ")}].`,
            changedGovernedSlots,
            changedGovernedEnvelopeKeys,
            changedExcludedSlots
          },
          isSameVariant
        );
        continue;
      }

      const evalCtx = {
        resolvedSlotBindings: slice.resolvedSlotBindings,
        itemRevisionsById: itemsById,
        variantEnvelope: variant.operatingEnvelope,
        testedOperatingConditions: ev.testedOperatingConditions
      };

      const envTrace = evaluatePredicateK3(rule.envelopePredicate, evalCtx);
      const valTrace = evaluatePredicateK3(rule.validityPredicate, evalCtx);

      if (envTrace.value === "FALSE") {
        consider(
          {
            sliceId: slice.sliceId,
            variantId: slice.variantId,
            interval: slice.interval,
            obligationId: obligation.obligationId,
            obligationCode: obligation.code,
            status: "INVALIDATED_ENVELOPE_EXCEEDED",
            supportingEvidenceId: ev.evidenceId,
            appliedCarryForwardRuleId: rule.ruleId,
            requiresDispositionSignoff: false,
            explanation: `Operating envelope outside rule "${rule.ruleId}": ${envTrace.reason}`,
            changedGovernedSlots,
            changedGovernedEnvelopeKeys,
            changedExcludedSlots,
            envelopeTrace: envTrace,
            validityTrace: valTrace
          },
          isSameVariant
        );
        continue;
      }

      if (valTrace.value === "FALSE") {
        consider(
          {
            sliceId: slice.sliceId,
            variantId: slice.variantId,
            interval: slice.interval,
            obligationId: obligation.obligationId,
            obligationCode: obligation.code,
            status: "INVALIDATED_PREDICATE_FALSE",
            supportingEvidenceId: ev.evidenceId,
            appliedCarryForwardRuleId: rule.ruleId,
            requiresDispositionSignoff: false,
            explanation: `Validity assumption defeated under rule "${rule.ruleId}": ${valTrace.reason}`,
            changedGovernedSlots,
            changedGovernedEnvelopeKeys,
            changedExcludedSlots,
            envelopeTrace: envTrace,
            validityTrace: valTrace
          },
          isSameVariant
        );
        continue;
      }

      if (envTrace.value === "UNKNOWN" || valTrace.value === "UNKNOWN") {
        const unknownReasons = [
          envTrace.value === "UNKNOWN" ? `Envelope indeterminate (${envTrace.reason})` : null,
          valTrace.value === "UNKNOWN" ? `Validity indeterminate (${valTrace.reason})` : null
        ]
          .filter(Boolean)
          .join("; ");
        consider(
          {
            sliceId: slice.sliceId,
            variantId: slice.variantId,
            interval: slice.interval,
            obligationId: obligation.obligationId,
            obligationCode: obligation.code,
            status: "INDETERMINATE_MISSING_DATA",
            supportingEvidenceId: ev.evidenceId,
            appliedCarryForwardRuleId: rule.ruleId,
            requiresDispositionSignoff: false,
            explanation: `Rule "${rule.ruleId}" evaluated to UNKNOWN (fail-closed): ${unknownReasons}`,
            changedGovernedSlots,
            changedGovernedEnvelopeKeys,
            changedExcludedSlots,
            envelopeTrace: envTrace,
            validityTrace: valTrace
          },
          isSameVariant
        );
        continue;
      }

      return {
        sliceId: slice.sliceId,
        variantId: slice.variantId,
        interval: slice.interval,
        obligationId: obligation.obligationId,
        obligationCode: obligation.code,
        status: "SUPPORTED_BY_APPROVED_RULE",
        supportingEvidenceId: ev.evidenceId,
        appliedCarryForwardRuleId: rule.ruleId,
        requiresDispositionSignoff: rule.requiresDispositionSignoff,
        explanation: `Supported via approved rule "${rule.ruleId}" (v${rule.ruleVersion}) from "${ev.evidenceId}": ${valTrace.reason}`,
        changedGovernedSlots,
        changedGovernedEnvelopeKeys,
        changedExcludedSlots,
        envelopeTrace: envTrace,
        validityTrace: valTrace
      };
    }
  }

  return bestAttempt!;
}

/**
 * Issue #2 (ABA Invalidation) & Separation-of-Duties Verifier:
 * Requires every attestation to match BOTH live snapshotSha256 AND monotonic approvalGeneration.
 */
function evaluateAttestations(params: {
  readonly input: VerificationInput;
  readonly snapshotSha256: string;
  readonly needsCarryForwardDispositionRole: boolean;
}): AttestationStatusSummary {
  const { input, snapshotSha256, needsCarryForwardDispositionRole } = params;
  const { policy } = input.catalog;

  const roleSet = new Set<string>(policy.requiredAttestationRoles);
  if (needsCarryForwardDispositionRole && policy.carryForwardDispositionRole) {
    roleSet.add(policy.carryForwardDispositionRole);
  }
  const requiredRoles = [...roleSet].sort();

  const candidateValid: RoleAttestation[] = [];
  const rejectedReasons: { attestationId: string; reason: string }[] = [];

  for (const att of input.attestations) {
    if (att.ecoJiraIssueId !== input.eco.ecoJiraIssueId) {
      rejectedReasons.push({
        attestationId: att.attestationId,
        reason: `Attestation bound to different ECO issue "${att.ecoJiraIssueId}"`
      });
      continue;
    }
    if (att.attestedApprovalGeneration !== input.eco.approvalGeneration) {
      rejectedReasons.push({
        attestationId: att.attestationId,
        reason: `ABA / approval-generation mismatch: attested generation ${att.attestedApprovalGeneration} != current generation ${input.eco.approvalGeneration}`
      });
      continue;
    }
    if (att.attestedSnapshotSha256 !== snapshotSha256) {
      rejectedReasons.push({
        attestationId: att.attestationId,
        reason: "Stale attestation: attestedSnapshotSha256 does not match current canonical state digest"
      });
      continue;
    }
    if (att.attestedPolicyVersion !== policy.policyVersion) {
      rejectedReasons.push({
        attestationId: att.attestationId,
        reason: `Policy version mismatch: attested v${att.attestedPolicyVersion} != live v${policy.policyVersion}`
      });
      continue;
    }
    if (!roleSet.has(att.roleName)) {
      rejectedReasons.push({
        attestationId: att.attestationId,
        reason: `Role "${att.roleName}" is not among required roles`
      });
      continue;
    }
    const liveMembers = input.trustedRoleMembersByRole[att.roleName] ?? [];
    if (!liveMembers.includes(att.signerAccountId)) {
      rejectedReasons.push({
        attestationId: att.attestationId,
        reason: `Account "${att.signerAccountId}" is not an active member of Jira role "${att.roleName}"`
      });
      continue;
    }
    if (policy.enforceSeparationOfDuties) {
      if (att.signerAccountId === input.eco.authorAccountId) {
        rejectedReasons.push({
          attestationId: att.attestationId,
          reason: `Separation-of-duties violation: signer "${att.signerAccountId}" is the ECO author`
        });
        continue;
      }
      if (att.signerAccountId === input.eco.lastEditorAccountId) {
        rejectedReasons.push({
          attestationId: att.attestationId,
          reason: `Separation-of-duties violation: signer "${att.signerAccountId}" is the last proposal editor`
        });
        continue;
      }
    }
    candidateValid.push(att);
  }

  if (!policy.enforceSeparationOfDuties) {
    const satisfiedRoles: string[] = [];
    const acceptedAttestations: RoleAttestation[] = [];
    for (const role of requiredRoles) {
      const match = candidateValid.find((c) => c.roleName === role);
      if (match) {
        satisfiedRoles.push(role);
        acceptedAttestations.push(match);
      }
    }
    const missingRoles = requiredRoles.filter((r) => !satisfiedRoles.includes(r));
    return {
      requiredRoles,
      satisfiedRoles,
      missingRoles,
      acceptedAttestations,
      rejectedReasons
    };
  }

  const roleToAtts = new Map<string, RoleAttestation[]>();
  for (const role of requiredRoles) {
    roleToAtts.set(
      role,
      candidateValid
        .filter((c) => c.roleName === role)
        .sort((a, b) => a.attestationId.localeCompare(b.attestationId))
    );
  }

  const signerMatchedToRole = new Map<string, { role: string; att: RoleAttestation }>();

  const tryAssignRole = (role: string, visitedSigners: Set<string>): boolean => {
    const options = roleToAtts.get(role) ?? [];
    for (const att of options) {
      if (visitedSigners.has(att.signerAccountId)) continue;
      visitedSigners.add(att.signerAccountId);
      const existing = signerMatchedToRole.get(att.signerAccountId);
      if (!existing || tryAssignRole(existing.role, visitedSigners)) {
        signerMatchedToRole.set(att.signerAccountId, { role, att });
        return true;
      }
    }
    return false;
  };

  for (const role of requiredRoles) {
    tryAssignRole(role, new Set<string>());
  }

  const roleToAccepted = new Map<string, RoleAttestation>();
  for (const { role, att } of signerMatchedToRole.values()) {
    roleToAccepted.set(role, att);
  }

  const acceptedIds = new Set([...roleToAccepted.values()].map((a) => a.attestationId));
  for (const att of candidateValid) {
    if (!acceptedIds.has(att.attestationId) && !roleToAccepted.has(att.roleName)) {
      rejectedReasons.push({
        attestationId: att.attestationId,
        reason: `Separation-of-duties violation: account "${att.signerAccountId}" cannot satisfy multiple required roles simultaneously`
      });
    }
  }

  const satisfiedRoles = requiredRoles.filter((r) => roleToAccepted.has(r));
  const missingRoles = requiredRoles.filter((r) => !roleToAccepted.has(r));
  const acceptedAttestations = satisfiedRoles.map((r) => roleToAccepted.get(r)!);

  return {
    requiredRoles,
    satisfiedRoles,
    missingRoles,
    acceptedAttestations,
    rejectedReasons
  };
}

export function verifyEngineeringChange(input: VerificationInput): VerificationEvaluation {
  const snapshotSha256 = computeSnapshotSha256({
    catalog: input.catalog,
    eco: input.eco,
    proposedOperations: input.proposedOperations,
    liveVerificationIssuesById: input.liveVerificationIssuesById
  });

  const { variantsById, itemsById, slices } = resolveEffectiveSlices(
    input.catalog,
    input.proposedOperations
  );

  const structuralErrors: string[] = [];
  for (const slice of slices) {
    for (const diag of slice.structuralDiagnostics) {
      structuralErrors.push(
        `${slice.variantId} ${formatInterval(slice.interval)}: [${diag.code}] ${diag.detail}`
      );
    }
  }

  const baselineSlices = resolveEffectiveSlices(input.catalog, []).slices;
  const baselineBindingsByVariant = new Map<string, Readonly<Record<string, string>>>();
  for (const bs of baselineSlices) {
    if (!baselineBindingsByVariant.has(bs.variantId)) {
      baselineBindingsByVariant.set(bs.variantId, bs.resolvedSlotBindings);
    }
  }

  const sliceObligations: SliceObligationEvaluation[] = [];
  for (const slice of slices) {
    const variant = variantsById.get(slice.variantId);
    if (!variant) continue;
    for (const obl of input.catalog.obligations) {
      if (!obligationAppliesToVariant(obl, slice.variantId)) continue;
      if (slice.structuralDiagnostics.length > 0) {
        sliceObligations.push({
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obl.obligationId,
          obligationCode: obl.code,
          status: "INDETERMINATE_MISSING_DATA",
          supportingEvidenceId: null,
          appliedCarryForwardRuleId: null,
          requiresDispositionSignoff: false,
          explanation: `Slice blocked by structural BOM/spec error: ${slice.structuralDiagnostics.map((d) => `${d.code}: ${d.detail}`).join("; ")}`,
          changedGovernedSlots: [],
          changedGovernedEnvelopeKeys: [],
          changedExcludedSlots: []
        });
      } else {
        sliceObligations.push(
          evaluateObligationOnSlice({
            catalog: input.catalog,
            slice,
            variant,
            obligation: obl,
            itemsById,
            liveIssuesById: input.liveVerificationIssuesById,
            baselineVariantBindings: baselineBindingsByVariant.get(slice.variantId)
          })
        );
      }
    }
  }

  const needsDispositionRole = sliceObligations.some(
    (so) => so.status === "SUPPORTED_BY_APPROVED_RULE" && so.requiresDispositionSignoff
  );

  const attestationSummary = evaluateAttestations({
    input,
    snapshotSha256,
    needsCarryForwardDispositionRole: needsDispositionRole
  });

  const remediationPlans =
    structuralErrors.length === 0
      ? computeRemediationPlans({
          catalog: input.catalog,
          slices,
          sliceObligations
        })
      : [];

  const invalidatedReasons: string[] = [];
  const indeterminateReasons: string[] = [];
  const incompleteReasons: string[] = [];

  for (const so of sliceObligations) {
    const prefix = `${so.variantId} ${formatInterval(so.interval)} [${so.obligationCode}]`;
    if (
      so.status === "INVALIDATED_EVIDENCE_DRIFT" ||
      so.status === "INVALIDATED_UNCOVERED_CHANGE" ||
      so.status === "INVALIDATED_ENVELOPE_EXCEEDED" ||
      so.status === "INVALIDATED_PREDICATE_FALSE" ||
      so.status === "INVALIDATED_RETEST_REQUIRED"
    ) {
      invalidatedReasons.push(`${prefix}: ${so.status} — ${so.explanation}`);
    } else if (
      so.status === "INDETERMINATE_MISSING_DATA" ||
      so.status === "INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT" ||
      so.status === "INDETERMINATE_UNEXAMINED_DEPENDENCY" ||
      so.status === "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION"
    ) {
      indeterminateReasons.push(`${prefix}: ${so.status} — ${so.explanation}`);
    } else if (so.status === "UNCOVERED_OR_UNEXECUTED") {
      incompleteReasons.push(`${prefix}: ${so.status} — ${so.explanation}`);
    }
  }

  let baseGateState: EcoGateState;
  const blockingReasons: string[] = [];

  if (structuralErrors.length > 0) {
    baseGateState = "BLOCKED_STRUCTURAL";
    blockingReasons.push(...structuralErrors);
  } else if (invalidatedReasons.length > 0) {
    baseGateState = "BLOCKED_INVALIDATED";
    blockingReasons.push(...invalidatedReasons, ...indeterminateReasons, ...incompleteReasons);
  } else if (indeterminateReasons.length > 0) {
    baseGateState = "BLOCKED_INDETERMINATE";
    blockingReasons.push(...indeterminateReasons, ...incompleteReasons);
  } else if (incompleteReasons.length > 0) {
    baseGateState = "EVIDENCE_INCOMPLETE";
    blockingReasons.push(...incompleteReasons);
  } else if (attestationSummary.missingRoles.length > 0) {
    baseGateState = "AWAITING_ATTESTATION";
    blockingReasons.push(
      `Missing valid human role attestation(s) for snapshot ${snapshotSha256.slice(0, 12)} (gen ${input.eco.approvalGeneration}): [${attestationSummary.missingRoles.join(", ")}]`
    );
  } else {
    baseGateState = "READY_FOR_RELEASE_TRANSITION";
  }

  // Issue #3: Two-phase post-transition verification requires a finalizedReleaseReceipt
  // (NOT merely a pre-transition PendingTransitionIntent) matching live snapshot, generation & policy.
  const finalizedMatchesLive =
    Boolean(input.finalizedReleaseReceipt) &&
    input.finalizedReleaseReceipt!.ecoJiraIssueId === input.eco.ecoJiraIssueId &&
    input.finalizedReleaseReceipt!.verifiedSnapshotSha256 === snapshotSha256 &&
    input.finalizedReleaseReceipt!.verifiedApprovalGeneration === input.eco.approvalGeneration &&
    input.finalizedReleaseReceipt!.verifiedPolicyVersion === input.catalog.policy.policyVersion &&
    baseGateState === "READY_FOR_RELEASE_TRANSITION";

  const ecoReachedDoneCategory = input.eco.liveEcoStatusCategoryKey?.toLowerCase() === "done";

  let gateState: EcoGateState = baseGateState;
  if (input.unvalidatedDriftDetected || (ecoReachedDoneCategory && !finalizedMatchesLive)) {
    gateState = "UNVALIDATED_RELEASE_DRIFT";
    blockingReasons.unshift(
      "ECO is in a Done-category status without a matching finalized release receipt for the live snapshot & approval generation (unprotected transition, mid-transition TOCTOU race, or post-release drift)."
    );
  } else if (ecoReachedDoneCategory && finalizedMatchesLive) {
    gateState = "RELEASE_TRANSITIONED_VERIFIED";
  }

  const transitionAllowed =
    gateState === "READY_FOR_RELEASE_TRANSITION" ||
    gateState === "RELEASE_TRANSITIONED_VERIFIED";

  return {
    snapshotSha256,
    approvalGeneration: input.eco.approvalGeneration,
    policyVersion: input.catalog.policy.policyVersion,
    gateState,
    transitionAllowed,
    slices,
    sliceObligations,
    attestationSummary,
    remediationPlans,
    blockingReasons
  };
}
