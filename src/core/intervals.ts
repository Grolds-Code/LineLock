import { canonicalizeJson, materializeEffectiveCatalogState } from "./canonical";
import type {
  BomEffectivityEdge,
  ChangeOperation,
  EffectiveSlice,
  FamilyCatalog,
  ItemRevision,
  ProductVariant,
  SerialInterval,
  SliceStructuralDiagnostic
} from "./types";

function edgeAppliesToVariantAndSerial(
  edge: BomEffectivityEdge,
  variantId: string,
  serialPoint: number
): boolean {
  const variantMatches = edge.variantScope === "ALL" || edge.variantScope.includes(variantId);
  if (!variantMatches) {
    return false;
  }
  return edge.serialFrom <= serialPoint && (edge.serialTo === null || serialPoint < edge.serialTo);
}

function validateEdgeSerialBounds(edges: readonly BomEffectivityEdge[]): SliceStructuralDiagnostic[] {
  const diagnostics: SliceStructuralDiagnostic[] = [];
  for (const edge of edges) {
    if (!Number.isSafeInteger(edge.serialFrom) || edge.serialFrom < 1) {
      diagnostics.push({
        code: "INVALID_SERIAL_BOUNDS",
        detail: `Edge "${edge.edgeId}" has invalid serialFrom=${edge.serialFrom} (must be integer >= 1)`,
        slotPath: edge.slotKey
      });
    }
    if (
      edge.serialTo !== null &&
      (!Number.isSafeInteger(edge.serialTo) || edge.serialTo <= edge.serialFrom)
    ) {
      diagnostics.push({
        code: "INVALID_SERIAL_BOUNDS",
        detail: `Edge "${edge.edgeId}" has invalid serialTo=${String(edge.serialTo)} <= serialFrom=${edge.serialFrom}`,
        slotPath: edge.slotKey
      });
    }
  }
  return diagnostics;
}

export function computeElementaryIntervals(
  edges: readonly BomEffectivityEdge[],
  initialSerial?: number
): SerialInterval[] {
  const validStarts = edges
    .map((e) => e.serialFrom)
    .filter((s) => Number.isSafeInteger(s) && s >= 1);
  const anchor =
    initialSerial !== undefined && Number.isSafeInteger(initialSerial) && initialSerial >= 1
      ? initialSerial
      : validStarts.length > 0
        ? Math.min(...validStarts)
        : 1;

  const boundarySet = new Set<number>([anchor]);
  for (const edge of edges) {
    if (Number.isSafeInteger(edge.serialFrom) && edge.serialFrom >= anchor) {
      boundarySet.add(edge.serialFrom);
    }
    if (
      edge.serialTo !== null &&
      Number.isSafeInteger(edge.serialTo) &&
      edge.serialTo > edge.serialFrom &&
      edge.serialTo > anchor
    ) {
      boundarySet.add(edge.serialTo);
    }
  }
  const sorted = [...boundarySet].sort((a, b) => a - b);
  const intervals: SerialInterval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    intervals.push({ serialFrom: sorted[i]!, serialTo: sorted[i + 1]! });
  }
  intervals.push({ serialFrom: sorted[sorted.length - 1]!, serialTo: null });
  return intervals;
}

export function formatInterval(interval: SerialInterval): string {
  return interval.serialTo === null
    ? `[SN ${interval.serialFrom}..+inf)`
    : `[SN ${interval.serialFrom}..${interval.serialTo})`;
}

function resolveVariantIntervalSlice(params: {
  readonly rootAssemblyRevId: string;
  readonly activeEdges: readonly BomEffectivityEdge[];
  readonly itemsById: ReadonlyMap<string, ItemRevision>;
  readonly globalBoundDiagnostics: readonly SliceStructuralDiagnostic[];
}): {
  readonly resolvedSlotBindings: Record<string, string>;
  readonly leafSlotPaths: string[];
  readonly diagnostics: SliceStructuralDiagnostic[];
} {
  const { rootAssemblyRevId, activeEdges, itemsById, globalBoundDiagnostics } = params;
  const diagnostics: SliceStructuralDiagnostic[] = [...globalBoundDiagnostics];
  const resolvedSlotBindings: Record<string, string> = {};
  const leafSlotPaths: string[] = [];

  const byParentSlot = new Map<string, Map<string, BomEffectivityEdge[]>>();
  for (const edge of activeEdges) {
    let slotMap = byParentSlot.get(edge.parentItemRevId);
    if (!slotMap) {
      slotMap = new Map<string, BomEffectivityEdge[]>();
      byParentSlot.set(edge.parentItemRevId, slotMap);
    }
    const bucket = slotMap.get(edge.slotKey) ?? [];
    bucket.push(edge);
    slotMap.set(edge.slotKey, bucket);
  }

  const rootItem = itemsById.get(rootAssemblyRevId);
  if (!rootItem) {
    diagnostics.push({
      code: "MISSING_ITEM_REVISION",
      detail: `Root assembly revision "${rootAssemblyRevId}" is missing from catalog`
    });
    return { resolvedSlotBindings, leafSlotPaths, diagnostics };
  }
  if (rootItem.specStatus !== "APPROVED") {
    diagnostics.push({
      code: "UNAPPROVED_ITEM_SPEC",
      detail: `Root assembly "${rootAssemblyRevId}" has specStatus "${rootItem.specStatus}" (must be APPROVED)`
    });
  }

  const dfs = (currentRevId: string, prefixPath: string, ancestorStack: ReadonlySet<string>): void => {
    const slotMap = byParentSlot.get(currentRevId);
    if (!slotMap) return;
    const sortedSlots = [...slotMap.keys()].sort();
    for (const slotKey of sortedSlots) {
      const slotPath = prefixPath ? `${prefixPath}/${slotKey}` : slotKey;
      const candidates = slotMap.get(slotKey)!;
      if (candidates.length > 1) {
        const ids = candidates
          .map((c) => `${c.edgeId}->${c.childItemRevId}`)
          .sort()
          .join(", ");
        diagnostics.push({
          code: "OVERLAPPING_EFFECTIVITY",
          detail: `Overlapping active BOM edges on parent "${currentRevId}" slot "${slotPath}": [${ids}]`,
          slotPath
        });
        continue;
      }

      const chosen = candidates[0]!;
      if (ancestorStack.has(chosen.childItemRevId)) {
        diagnostics.push({
          code: "CYCLIC_BOM",
          detail: `BOM cycle detected at "${slotPath}": "${currentRevId}" -> "${chosen.childItemRevId}"`,
          slotPath
        });
        continue;
      }

      resolvedSlotBindings[slotPath] = chosen.childItemRevId;

      const childItem = itemsById.get(chosen.childItemRevId);
      if (!childItem) {
        diagnostics.push({
          code: "MISSING_ITEM_REVISION",
          detail: `Missing ItemRevision "${chosen.childItemRevId}" at slot "${slotPath}"`,
          slotPath
        });
        continue;
      }
      if (childItem.specStatus !== "APPROVED") {
        diagnostics.push({
          code: "UNAPPROVED_ITEM_SPEC",
          detail: `ItemRevision "${chosen.childItemRevId}" at slot "${slotPath}" has specStatus "${childItem.specStatus}" (must be APPROVED)`,
          slotPath
        });
      }

      if (childItem.itemKind === "ASSEMBLY") {
        const nextAncestors = new Set(ancestorStack);
        nextAncestors.add(chosen.childItemRevId);
        dfs(chosen.childItemRevId, slotPath, nextAncestors);
      } else {
        leafSlotPaths.push(slotPath);
      }
    }
  };

  dfs(rootAssemblyRevId, "", new Set<string>([rootAssemblyRevId]));

  leafSlotPaths.sort();
  diagnostics.sort((a, b) =>
    `${a.code}:${a.slotPath ?? ""}:${a.detail}`.localeCompare(
      `${b.code}:${b.slotPath ?? ""}:${b.detail}`
    )
  );

  return { resolvedSlotBindings, leafSlotPaths, diagnostics };
}

export function resolveEffectiveSlices(
  catalog: FamilyCatalog,
  operations: readonly ChangeOperation[]
): {
  readonly variantsById: ReadonlyMap<string, ProductVariant>;
  readonly itemsById: ReadonlyMap<string, ItemRevision>;
  readonly effectiveEdges: readonly BomEffectivityEdge[];
  readonly slices: readonly EffectiveSlice[];
} {
  const { variants, edges } = materializeEffectiveCatalogState(catalog, operations);
  const variantsById = new Map<string, ProductVariant>(variants.map((v) => [v.variantId, v]));
  const itemsById = new Map<string, ItemRevision>(
    catalog.itemRevisions.map((item) => [item.itemRevId, item])
  );

  const globalBoundDiagnostics = validateEdgeSerialBounds(edges);
  const elementaryIntervals = computeElementaryIntervals(edges);

  const coalescedSlices: EffectiveSlice[] = [];

  for (const variant of variants) {
    let pending: {
      interval: SerialInterval;
      resolvedSlotBindings: Record<string, string>;
      leafSlotPaths: string[];
      diagnostics: SliceStructuralDiagnostic[];
      signature: string;
    } | null = null;

    for (const elemInterval of elementaryIntervals) {
      const activeEdges = edges.filter((e) =>
        edgeAppliesToVariantAndSerial(e, variant.variantId, elemInterval.serialFrom)
      );
      const resolved = resolveVariantIntervalSlice({
        rootAssemblyRevId: catalog.rootAssemblyRevId,
        activeEdges,
        itemsById,
        globalBoundDiagnostics
      });

      const signature = canonicalizeJson({
        bindings: resolved.resolvedSlotBindings,
        leaves: resolved.leafSlotPaths,
        diagnostics: resolved.diagnostics
      });

      if (
        pending &&
        pending.signature === signature &&
        pending.interval.serialTo === elemInterval.serialFrom
      ) {
        pending.interval = {
          serialFrom: pending.interval.serialFrom,
          serialTo: elemInterval.serialTo
        };
      } else {
        if (pending) {
          coalescedSlices.push({
            sliceId: `${variant.variantId}@${pending.interval.serialFrom}..${pending.interval.serialTo ?? "INF"}`,
            variantId: variant.variantId,
            interval: pending.interval,
            resolvedSlotBindings: pending.resolvedSlotBindings,
            leafSlotPaths: pending.leafSlotPaths,
            structuralDiagnostics: pending.diagnostics
          });
        }
        pending = {
          interval: elemInterval,
          resolvedSlotBindings: resolved.resolvedSlotBindings,
          leafSlotPaths: resolved.leafSlotPaths,
          diagnostics: resolved.diagnostics,
          signature
        };
      }
    }

    if (pending) {
      coalescedSlices.push({
        sliceId: `${variant.variantId}@${pending.interval.serialFrom}..${pending.interval.serialTo ?? "INF"}`,
        variantId: variant.variantId,
        interval: pending.interval,
        resolvedSlotBindings: pending.resolvedSlotBindings,
        leafSlotPaths: pending.leafSlotPaths,
        structuralDiagnostics: pending.diagnostics
      });
    }
  }

  return {
    variantsById,
    itemsById,
    effectiveEdges: edges,
    slices: coalescedSlices
  };
}

export function buildSerialScopedSubstitutionOps(params: {
  readonly currentEdges: readonly BomEffectivityEdge[];
  readonly allVariantIds: readonly string[];
  readonly parentItemRevId: string;
  readonly slotKey: string;
  readonly newChildItemRevId: string;
  readonly newEdgeIdPrefix: string;
  readonly targetVariants: "ALL" | readonly string[];
  readonly serialFrom: number;
  readonly serialTo: number | null;
}): ChangeOperation[] {
  const {
    currentEdges,
    allVariantIds,
    parentItemRevId,
    slotKey,
    newChildItemRevId,
    newEdgeIdPrefix,
    targetVariants,
    serialFrom,
    serialTo
  } = params;

  const targetSet =
    targetVariants === "ALL" ? new Set(allVariantIds) : new Set(targetVariants);
  const ops: ChangeOperation[] = [];

  for (const edge of currentEdges) {
    if (edge.parentItemRevId !== parentItemRevId || edge.slotKey !== slotKey) {
      continue;
    }
    const edgeVariants =
      edge.variantScope === "ALL" ? [...allVariantIds] : [...edge.variantScope];
    const affectedVariants = edgeVariants.filter((v) => targetSet.has(v));
    if (affectedVariants.length === 0) continue;

    const overlaps =
      (edge.serialTo === null || serialFrom < edge.serialTo) &&
      (serialTo === null || edge.serialFrom < serialTo);
    if (!overlaps) continue;

    const unaffectedVariants = edgeVariants.filter((v) => !targetSet.has(v));
    ops.push({ op: "REMOVE_EDGE", edgeId: edge.edgeId });

    if (unaffectedVariants.length > 0) {
      ops.push({
        op: "UPSERT_EDGE",
        edge: {
          ...edge,
          edgeId: `${edge.edgeId}__keep_var`,
          variantScope: unaffectedVariants
        }
      });
    }

    const affectedScope: "ALL" | readonly string[] =
      unaffectedVariants.length === 0 && edge.variantScope === "ALL"
        ? "ALL"
        : affectedVariants;

    if (edge.serialFrom < serialFrom) {
      ops.push({
        op: "UPSERT_EDGE",
        edge: {
          ...edge,
          edgeId: `${edge.edgeId}__pre_${serialFrom}`,
          variantScope: affectedScope,
          serialFrom: edge.serialFrom,
          serialTo: serialFrom
        }
      });
    }

    if (serialTo !== null && (edge.serialTo === null || serialTo < edge.serialTo)) {
      ops.push({
        op: "UPSERT_EDGE",
        edge: {
          ...edge,
          edgeId: `${edge.edgeId}__post_${serialTo}`,
          variantScope: affectedScope,
          serialFrom: serialTo,
          serialTo: edge.serialTo
        }
      });
    }
  }

  ops.push({
    op: "UPSERT_EDGE",
    edge: {
      edgeId: `${newEdgeIdPrefix}__sub`,
      parentItemRevId,
      slotKey,
      childItemRevId: newChildItemRevId,
      variantScope: targetVariants === "ALL" ? "ALL" : [...targetVariants],
      serialFrom,
      serialTo
    }
  });

  return ops;
}

export function invertChangeOperations(
  baseCatalog: FamilyCatalog,
  priorOperations: readonly ChangeOperation[],
  deltaOperations: readonly ChangeOperation[]
): ChangeOperation[] {
  const before = materializeEffectiveCatalogState(baseCatalog, priorOperations);
  const edgeMap = new Map<string, BomEffectivityEdge>(before.edges.map((e) => [e.edgeId, e]));
  const variantMap = new Map<string, ProductVariant>(
    before.variants.map((v) => [v.variantId, v])
  );

  const undoStack: ChangeOperation[] = [];

  for (const op of deltaOperations) {
    if (op.op === "UPSERT_EDGE") {
      const prev = edgeMap.get(op.edge.edgeId);
      if (prev) {
        undoStack.push({ op: "UPSERT_EDGE", edge: prev });
      } else {
        undoStack.push({ op: "REMOVE_EDGE", edgeId: op.edge.edgeId });
      }
      edgeMap.set(op.edge.edgeId, op.edge);
    } else if (op.op === "REMOVE_EDGE") {
      const prev = edgeMap.get(op.edgeId);
      if (prev) {
        undoStack.push({ op: "UPSERT_EDGE", edge: prev });
        edgeMap.delete(op.edgeId);
      }
    } else if (op.op === "SET_VARIANT_ENVELOPE") {
      const prev = variantMap.get(op.variantId);
      if (prev) {
        undoStack.push({
          op: "SET_VARIANT_ENVELOPE",
          variantId: op.variantId,
          operatingEnvelope: prev.operatingEnvelope
        });
        variantMap.set(op.variantId, {
          ...prev,
          operatingEnvelope: op.operatingEnvelope
        });
      }
    }
  }

  return undoStack.reverse();
}
