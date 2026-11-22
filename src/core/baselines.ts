import { computePinnedIssueStateHash } from "./canonical";
import { resolveEffectiveSlices } from "./intervals";
import { compareExactQuantities } from "./predicates";
import type {
  EffectiveSlice,
  ProductVariant,
  ScalarValue,
  SerialInterval,
  VerificationInput,
  VerificationObligation
} from "./types";

export type BaselineVerdict = "SUPPORTED" | "REQUIRES_REVERIFICATION";

export interface BaselineSliceObligationResult {
  readonly sliceId: string;
  readonly variantId: string;
  readonly interval: SerialInterval;
  readonly obligationId: string;
  readonly verdict: BaselineVerdict;
  readonly reason: string;
}

function obligationApplies(obl: VerificationObligation, variantId: string): boolean {
  return obl.applicableVariants === "ALL" || obl.applicableVariants.includes(variantId);
}

/**
 * Baseline B0: Timestamp & Issue-Status Gate.
 * Approves iff >=1 linked Jira verification issue is Done and updated >= ECO creation.
 */
export function evaluateB0TimestampStatus(
  input: VerificationInput
): BaselineSliceObligationResult[] {
  const { slices } = resolveEffectiveSlices(input.catalog, input.proposedOperations);
  const results: BaselineSliceObligationResult[] = [];

  for (const slice of slices) {
    for (const obl of input.catalog.obligations) {
      if (!obligationApplies(obl, slice.variantId)) continue;
      const evs = input.catalog.evidenceRecords.filter((e) => e.obligationId === obl.obligationId);
      const freshDone = evs.find((ev) => {
        const live = input.liveVerificationIssuesById[ev.jiraIssueId];
        if (!live) return false;
        return (
          live.statusCategoryKey.toLowerCase() === "done" &&
          live.updatedAtEpochMs >= input.eco.ecoCreatedAtEpochMs
        );
      });
      results.push({
        sliceId: slice.sliceId,
        variantId: slice.variantId,
        interval: slice.interval,
        obligationId: obl.obligationId,
        verdict: freshDone ? "SUPPORTED" : "REQUIRES_REVERIFICATION",
        reason: freshDone
          ? `Issue ${freshDone.jiraIssueKey} is Done and updated >= ECO creation`
          : "No Done issue updated at or after ECO creation"
      });
    }
  }
  return results;
}

/**
 * Baseline B1: Untyped Multi-Hop Suspect-Link Reachability (Classic ALM Suspect Flag).
 * Flags any obligation whose recorded testedSlotBinding touches a slot modified anywhere in the ECO.
 */
export function evaluateB1UntypedSuspectGraph(
  input: VerificationInput
): BaselineSliceObligationResult[] {
  const { slices } = resolveEffectiveSlices(input.catalog, input.proposedOperations);
  const baselineSlices = resolveEffectiveSlices(input.catalog, []).slices;

  const touchedSlotSuffixes = new Set<string>();
  const baselineSlotsByVariant = new Map<string, Record<string, string>>();
  for (const bs of baselineSlices) {
    baselineSlotsByVariant.set(bs.variantId, {
      ...(baselineSlotsByVariant.get(bs.variantId) ?? {}),
      ...bs.resolvedSlotBindings
    });
  }

  for (const s of slices) {
    const baseBindings = baselineSlotsByVariant.get(s.variantId) ?? {};
    for (const [pathKey, revId] of Object.entries(s.resolvedSlotBindings)) {
      if (baseBindings[pathKey] !== revId) {
        touchedSlotSuffixes.add(pathKey);
        touchedSlotSuffixes.add(pathKey.split("/").pop()!);
      }
    }
  }

  const results: BaselineSliceObligationResult[] = [];
  for (const slice of slices) {
    const hasStructuralErr = slice.structuralDiagnostics.length > 0;
    for (const obl of input.catalog.obligations) {
      if (!obligationApplies(obl, slice.variantId)) continue;
      if (hasStructuralErr) {
        results.push({
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obl.obligationId,
          verdict: "REQUIRES_REVERIFICATION",
          reason: "Structural BOM error"
        });
        continue;
      }

      const evs = input.catalog.evidenceRecords.filter(
        (e) =>
          e.obligationId === obl.obligationId &&
          e.approvalStatus === "APPROVED" &&
          e.recordedOutcome === "PASS"
      );
      if (evs.length === 0) {
        results.push({
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obl.obligationId,
          verdict: "REQUIRES_REVERIFICATION",
          reason: "No approved passing evidence"
        });
        continue;
      }

      const anyTouched = evs.some((ev) =>
        Object.keys(ev.testedSlotBinding).some((slotPath) => {
          const leaf = slotPath.split("/").pop()!;
          return touchedSlotSuffixes.has(slotPath) || touchedSlotSuffixes.has(leaf);
        })
      );

      results.push({
        sliceId: slice.sliceId,
        variantId: slice.variantId,
        interval: slice.interval,
        obligationId: obl.obligationId,
        verdict: anyTouched ? "REQUIRES_REVERIFICATION" : "SUPPORTED",
        reason: anyTouched
          ? "Boolean suspect link propagated across all slices/variants"
          : "No upstream suspect link triggered"
      });
    }
  }

  return results;
}

/**
 * Standard upper-bound envelope check used by strengthened Baseline B2:
 * Checks every key recorded in evidence.testedOperatingConditions against variant.operatingEnvelope:
 * - enum / boolean: exact equality
 * - quantity: same unit AND variantValue <= testedValue (standard upper-stress check)
 */
function standardOperatingEnvelopeCheck(
  variantEnvelope: Readonly<Record<string, ScalarValue>>,
  testedConditions: Readonly<Record<string, ScalarValue>>
): boolean {
  for (const [key, testedVal] of Object.entries(testedConditions)) {
    const varVal = variantEnvelope[key];
    if (!varVal || varVal.kind !== testedVal.kind) {
      return false;
    }
    if (testedVal.kind === "boolean" && varVal.kind === "boolean") {
      if (varVal.value !== testedVal.value) return false;
    } else if (testedVal.kind === "enum" && varVal.kind === "enum") {
      if (varVal.value !== testedVal.value) return false;
    } else if (testedVal.kind === "quantity" && varVal.kind === "quantity") {
      const cmp = compareExactQuantities(
        { mantissa: BigInt(varVal.mantissa), scale: varVal.scale, unit: varVal.unit },
        { mantissa: BigInt(testedVal.mantissa), scale: testedVal.scale, unit: testedVal.unit }
      );
      if (!cmp.comparable || cmp.cmp > 0) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Issue #6 — Strengthened Baseline B2: Competent Version-, Effectivity- & Operating-Envelope Baseline.
 *
 * Performs:
 * 1. Exact elementary serial-interval & variant resolution
 * 2. Live Jira verification issue status & pinned content-hash verification
 * 3. Exact component-revision matching on all keys in evidence.testedSlotBinding
 * 4. Standard upper-bound operating-envelope comparison (variant[k] <= tested[k]) on all keys
 *    in evidence.testedOperatingConditions.
 *
 * Remaining blind spots that LineLock resolves:
 * - Partial evidence footprint omissions (omitted governed slots in testedSlotBinding)
 * - Newly added unexamined BOM components or unexamined environmental axes (e.g. salt_fog)
 * - Directional/non-monotonic environmental bounds (e.g. cold-soak min_ambient -40C <= -20C)
 * - Explicit rule-authorized carry-forward on qualified alternate component revisions.
 */
export function evaluateB2CompetentVersionAndEnvelope(
  input: VerificationInput
): BaselineSliceObligationResult[] {
  const { variantsById, slices } = resolveEffectiveSlices(input.catalog, input.proposedOperations);
  const results: BaselineSliceObligationResult[] = [];

  for (const slice of slices) {
    const variant = variantsById.get(slice.variantId);
    if (!variant || slice.structuralDiagnostics.length > 0) {
      for (const obl of input.catalog.obligations) {
        if (!obligationApplies(obl, slice.variantId)) continue;
        results.push({
          sliceId: slice.sliceId,
          variantId: slice.variantId,
          interval: slice.interval,
          obligationId: obl.obligationId,
          verdict: "REQUIRES_REVERIFICATION",
          reason: "Structural BOM error"
        });
      }
      continue;
    }

    for (const obl of input.catalog.obligations) {
      if (!obligationApplies(obl, slice.variantId)) continue;
      const matchingEv = findCompetentBaselineMatch(slice, variant, obl.obligationId, input);
      results.push({
        sliceId: slice.sliceId,
        variantId: slice.variantId,
        interval: slice.interval,
        obligationId: obl.obligationId,
        verdict: matchingEv ? "SUPPORTED" : "REQUIRES_REVERIFICATION",
        reason: matchingEv
          ? `Exact testedSlotBinding + standard operating-envelope check passed (${matchingEv})`
          : "Revision mismatch, upper-envelope exceeded, or drifted Jira evidence"
      });
    }
  }

  return results;
}

function findCompetentBaselineMatch(
  slice: EffectiveSlice,
  variant: ProductVariant,
  obligationId: string,
  input: VerificationInput
): string | null {
  const candidates = input.catalog.evidenceRecords.filter(
    (e) =>
      e.obligationId === obligationId &&
      e.testedVariantId === slice.variantId &&
      e.approvalStatus === "APPROVED" &&
      e.recordedOutcome === "PASS"
  );

  for (const ev of candidates) {
    const live = input.liveVerificationIssuesById[ev.jiraIssueId];
    if (!live || live.statusCategoryKey.toLowerCase() !== "done") continue;
    if (computePinnedIssueStateHash(live) !== ev.pinnedIssueStateHash) continue;

    // Checks all slots listed in ev.testedSlotBinding
    const allListedSlotsMatch = Object.entries(ev.testedSlotBinding).every(
      ([slotPath, revId]) => slice.resolvedSlotBindings[slotPath] === revId
    );
    if (!allListedSlotsMatch) continue;

    // Performs normal operating-envelope comparison across testedOperatingConditions
    if (!standardOperatingEnvelopeCheck(variant.operatingEnvelope, ev.testedOperatingConditions)) {
      continue;
    }

    return ev.evidenceId;
  }
  return null;
}
