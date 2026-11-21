import type {
  EffectiveSlice,
  FamilyCatalog,
  ObligationRemediationPlan,
  RemediationCandidateAction,
  RetestDominanceRule,
  SliceObligationEvaluation,
  VerificationObligation
} from "./types.js";

export const EXACT_MAX_UNIVERSE = 16;
export const EXACT_MAX_CANDIDATES = 20;

export interface SetCoverCandidate {
  readonly id: string;
  readonly coveredItems: readonly string[];
}

export interface SetCoverSolution {
  readonly solverMode: "EXACT_BOUNDED" | "APPROXIMATE_GREEDY";
  readonly selectedIds: readonly string[];
}

function popcount32(x: number): number {
  let n = x >>> 0;
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function solveMinimumSetCover(
  universe: readonly string[],
  candidates: readonly SetCoverCandidate[]
): SetCoverSolution {
  const uniqueUniverse = [...new Set(universe)].sort();
  if (uniqueUniverse.length === 0) {
    return { solverMode: "EXACT_BOUNDED", selectedIds: [] };
  }

  const sortedCandidates = [...candidates].sort((a, b) => a.id.localeCompare(b.id));

  if (
    uniqueUniverse.length <= EXACT_MAX_UNIVERSE &&
    sortedCandidates.length <= EXACT_MAX_CANDIDATES
  ) {
    const itemIndex = new Map<string, number>(uniqueUniverse.map((u, idx) => [u, idx]));
    const fullMask = (1 << uniqueUniverse.length) - 1;

    const masks: number[] = sortedCandidates.map((cand) => {
      let mask = 0;
      for (const item of cand.coveredItems) {
        const idx = itemIndex.get(item);
        if (idx !== undefined) mask |= 1 << idx;
      }
      return mask;
    });

    const suffixUnion: number[] = new Array<number>(sortedCandidates.length + 1).fill(0);
    for (let i = sortedCandidates.length - 1; i >= 0; i--) {
      suffixUnion[i] = suffixUnion[i + 1]! | masks[i]!;
    }

    const maxGainFrom: number[] = new Array<number>(sortedCandidates.length + 1).fill(0);
    for (let i = sortedCandidates.length - 1; i >= 0; i--) {
      maxGainFrom[i] = Math.max(maxGainFrom[i + 1]!, popcount32(masks[i]!));
    }

    if ((suffixUnion[0]! & fullMask) !== fullMask) {
      return solveGreedy(uniqueUniverse, sortedCandidates, "EXACT_BOUNDED");
    }

    let bestPickIndices: number[] | null = null;
    const currentPick: number[] = [];

    const compareIndexListsLex = (a: readonly number[], b: readonly number[]): number => {
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (a[i]! !== b[i]!) return a[i]! - b[i]!;
      }
      return a.length - b.length;
    };

    const search = (idx: number, coveredMask: number): void => {
      if (coveredMask === fullMask) {
        if (
          bestPickIndices === null ||
          currentPick.length < bestPickIndices.length ||
          (currentPick.length === bestPickIndices.length &&
            compareIndexListsLex(currentPick, bestPickIndices) < 0)
        ) {
          bestPickIndices = [...currentPick];
        }
        return;
      }
      if (idx >= sortedCandidates.length) return;
      if (((coveredMask | suffixUnion[idx]!) & fullMask) !== fullMask) return;

      if (bestPickIndices !== null) {
        const uncoveredCount = popcount32(fullMask & ~coveredMask);
        const maxSingle = maxGainFrom[idx]!;
        if (maxSingle === 0) return;
        const optimisticSteps = Math.ceil(uncoveredCount / maxSingle);
        if (currentPick.length + optimisticSteps > bestPickIndices.length) return;
      }

      const candMask = masks[idx]!;
      const nextCovered = coveredMask | candMask;
      if (nextCovered !== coveredMask) {
        currentPick.push(idx);
        search(idx + 1, nextCovered);
        currentPick.pop();
      }
      search(idx + 1, coveredMask);
    };

    search(0, 0);
    return {
      solverMode: "EXACT_BOUNDED",
      selectedIds: (bestPickIndices ?? []).map((i) => sortedCandidates[i]!.id)
    };
  }

  return solveGreedy(uniqueUniverse, sortedCandidates, "APPROXIMATE_GREEDY");
}

function solveGreedy(
  uniqueUniverse: readonly string[],
  sortedCandidates: readonly SetCoverCandidate[],
  mode: "EXACT_BOUNDED" | "APPROXIMATE_GREEDY"
): SetCoverSolution {
  const uncovered = new Set<string>(uniqueUniverse);
  const selectedIds: string[] = [];
  const used = new Set<string>();

  while (uncovered.size > 0) {
    let bestCand: SetCoverCandidate | null = null;
    let bestGain = 0;

    for (const cand of sortedCandidates) {
      if (used.has(cand.id)) continue;
      let gain = 0;
      for (const item of cand.coveredItems) {
        if (uncovered.has(item)) gain += 1;
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestCand = cand;
      }
    }

    if (!bestCand || bestGain === 0) break;
    used.add(bestCand.id);
    selectedIds.push(bestCand.id);
    for (const item of bestCand.coveredItems) uncovered.delete(item);
  }

  return { solverMode: mode, selectedIds };
}

function extractGovernedBindings(
  obl: VerificationObligation,
  sliceBindings: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...obl.governedSlotPaths].sort()) {
    const v = sliceBindings[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function bindingsEqual(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i]!;
    if (k !== kb[i] || a[k] !== b[k]) return false;
  }
  return true;
}

export function computeRemediationPlans(params: {
  readonly catalog: FamilyCatalog;
  readonly slices: readonly EffectiveSlice[];
  readonly sliceObligations: readonly SliceObligationEvaluation[];
}): ObligationRemediationPlan[] {
  const { catalog, slices, sliceObligations } = params;
  const slicesById = new Map<string, EffectiveSlice>(slices.map((s) => [s.sliceId, s]));
  const obligationsById = new Map<string, VerificationObligation>(
    catalog.obligations.map((o) => [o.obligationId, o])
  );
  const approvedDominanceRules: readonly RetestDominanceRule[] = (
    catalog.retestDominanceRules ?? []
  ).filter((r) => r.approvalStatus === "APPROVED");

  const unsatisfiedByObl = new Map<string, SliceObligationEvaluation[]>();
  for (const evalItem of sliceObligations) {
    if (
      evalItem.status === "SUPPORTED_AS_TESTED" ||
      evalItem.status === "SUPPORTED_BY_APPROVED_RULE"
    ) {
      continue;
    }
    const list = unsatisfiedByObl.get(evalItem.obligationId) ?? [];
    list.push(evalItem);
    unsatisfiedByObl.set(evalItem.obligationId, list);
  }

  const plans: ObligationRemediationPlan[] = [];
  for (const oblId of [...unsatisfiedByObl.keys()].sort()) {
    const obl = obligationsById.get(oblId);
    if (!obl) continue;
    const failedItems = unsatisfiedByObl.get(oblId)!;
    const universe = failedItems.map((f) => f.sliceId).sort();
    const candidateMap = new Map<string, RemediationCandidateAction>();

    for (const item of failedItems) {
      const slice = slicesById.get(item.sliceId);
      if (!slice) continue;
      const reqBindings = extractGovernedBindings(obl, slice.resolvedSlotBindings);

      const coveredSameVariant = failedItems
        .filter((other) => {
          const otherSlice = slicesById.get(other.sliceId);
          if (!otherSlice || otherSlice.variantId !== slice.variantId) return false;
          return bindingsEqual(
            reqBindings,
            extractGovernedBindings(obl, otherSlice.resolvedSlotBindings)
          );
        })
        .map((o) => o.sliceId);

      const dominatedVariants = new Set<string>();
      for (const domRule of approvedDominanceRules) {
        if (domRule.obligationId === oblId && domRule.coveringVariantId === slice.variantId) {
          for (const cv of domRule.coveredVariantIds) dominatedVariants.add(cv);
        }
      }

      const coveredCrossVariant = failedItems
        .filter((other) => {
          const otherSlice = slicesById.get(other.sliceId);
          if (!otherSlice || !dominatedVariants.has(otherSlice.variantId)) return false;
          return bindingsEqual(
            reqBindings,
            extractGovernedBindings(obl, otherSlice.resolvedSlotBindings)
          );
        })
        .map((o) => o.sliceId);

      const allCovered = [...new Set([...coveredSameVariant, ...coveredCrossVariant])].sort();
      const candId = `RETEST:${obl.code}:${slice.variantId}:${Object.entries(reqBindings)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")}`;

      if (!candidateMap.has(candId)) {
        candidateMap.set(candId, {
          candidateId: candId,
          obligationId: oblId,
          obligationCode: obl.code,
          targetVariantId: slice.variantId,
          targetInterval: slice.interval,
          requiredSlotBindings: reqBindings,
          coveredSliceIds: allCovered,
          reason:
            coveredCrossVariant.length > 0
              ? `Execute ${obl.code} on ${slice.variantId} (covers ${allCovered.length} slices via approved envelope dominance)`
              : `Execute ${obl.code} on ${slice.variantId} for configuration ${JSON.stringify(reqBindings)}`
        });
      }
    }

    const candidates = [...candidateMap.values()].sort((a, b) =>
      a.candidateId.localeCompare(b.candidateId)
    );
    const cover = solveMinimumSetCover(
      universe,
      candidates.map((c) => ({ id: c.candidateId, coveredItems: c.coveredSliceIds }))
    );
    const selectedSet = new Set(cover.selectedIds);
    plans.push({
      obligationId: oblId,
      obligationCode: obl.code,
      unsatisfiedSliceIds: universe,
      solverMode: cover.solverMode,
      selectedActions: candidates.filter((c) => selectedSet.has(c.candidateId))
    });
  }

  return plans;
}
