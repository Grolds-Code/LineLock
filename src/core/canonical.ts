import { createHash } from "node:crypto";
import type {
  BomEffectivityEdge,
  CarryForwardRule,
  ChangeOperation,
  EcoMetadata,
  FamilyCatalog,
  ItemRevision,
  LiveJiraIssueProjection,
  ProductVariant,
  ScalarValue,
  VerificationEvidence,
  VerificationObligation
} from "./types.js";

/**
 * RFC 8785 (JSON Canonicalization Scheme) deterministic serializer.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${String(value)}`);
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item === undefined ? null : item));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const props = sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`);
    return `{${props.join(",")}}`;
  }
  throw new TypeError(`Unsupported type in canonicalizeJson: ${typeof value}`);
}

export function sha256Hex(canonicalPayload: string): string {
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function normalizeScalarValue(val: ScalarValue): unknown {
  if (val.kind !== "quantity") {
    return val;
  }
  if (val.mantissa === 0) {
    return { kind: "quantity", mantissa: "0", scale: 0, unit: val.unit };
  }
  let m = BigInt(val.mantissa);
  let s = val.scale;
  while (m !== 0n && m % 10n === 0n) {
    m /= 10n;
    s += 1;
  }
  return { kind: "quantity", mantissa: m.toString(10), scale: s, unit: val.unit };
}

function normalizeScalarMap(map: Readonly<Record<string, ScalarValue>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(map).sort()) {
    const val = map[key];
    if (val !== undefined) {
      out[key] = normalizeScalarValue(val);
    }
  }
  return out;
}

export function computePinnedIssueStateHash(issue: LiveJiraIssueProjection): string {
  const projection = {
    projectionVersion: 1,
    issueId: issue.issueId,
    summary: issue.summary,
    description: issue.description,
    statusCategoryKey: issue.statusCategoryKey.toLowerCase(),
    resolutionName: issue.resolutionName ?? null,
    structuredFields: normalizeScalarMap(issue.structuredFields)
  };
  return sha256Hex(canonicalizeJson(projection));
}

function normalizeVariantScope(scope: "ALL" | readonly string[]): "ALL" | string[] {
  return scope === "ALL" ? "ALL" : [...new Set(scope)].sort();
}

function normalizeEdge(edge: BomEffectivityEdge): unknown {
  return {
    edgeId: edge.edgeId,
    parentItemRevId: edge.parentItemRevId,
    slotKey: edge.slotKey,
    childItemRevId: edge.childItemRevId,
    variantScope: normalizeVariantScope(edge.variantScope),
    serialFrom: edge.serialFrom,
    serialTo: edge.serialTo
  };
}

function normalizeVariant(v: ProductVariant): unknown {
  return {
    variantId: v.variantId,
    skuCode: v.skuCode,
    operatingEnvelope: normalizeScalarMap(v.operatingEnvelope)
  };
}

function normalizeItemRevision(item: ItemRevision): unknown {
  return {
    itemRevId: item.itemRevId,
    partNumber: item.partNumber,
    revision: item.revision,
    itemKind: item.itemKind,
    specStatus: item.specStatus,
    attributes: normalizeScalarMap(item.attributes)
  };
}

function normalizeObligation(obl: VerificationObligation): unknown {
  return {
    obligationId: obl.obligationId,
    code: obl.code,
    applicableVariants: normalizeVariantScope(obl.applicableVariants),
    carryForwardMode: obl.carryForwardMode,
    governedSlotPaths: [...new Set(obl.governedSlotPaths)].sort(),
    excludedSlots: [...obl.excludedSlots]
      .sort((a, b) => a.slotPath.localeCompare(b.slotPath))
      .map((e) => ({
        slotPath: e.slotPath,
        justification: e.justification,
        approvedByAccountId: e.approvedByAccountId
      })),
    governedEnvelopeKeys: [...new Set(obl.governedEnvelopeKeys)].sort(),
    excludedEnvelopeKeys: [...obl.excludedEnvelopeKeys]
      .sort((a, b) => a.envKey.localeCompare(b.envKey))
      .map((e) => ({
        envKey: e.envKey,
        justification: e.justification,
        approvedByAccountId: e.approvedByAccountId
      }))
  };
}

function normalizeEvidence(
  ev: VerificationEvidence,
  liveIssuesById: Readonly<Record<string, LiveJiraIssueProjection>>
): unknown {
  const live = liveIssuesById[ev.jiraIssueId];
  return {
    evidenceId: ev.evidenceId,
    obligationId: ev.obligationId,
    jiraIssueId: ev.jiraIssueId,
    pinnedIssueStateHash: ev.pinnedIssueStateHash,
    liveStatusCategoryKey: live ? live.statusCategoryKey.toLowerCase() : "MISSING",
    liveIssueStateHash: live ? computePinnedIssueStateHash(live) : "MISSING",
    testedVariantId: ev.testedVariantId,
    testedSlotBinding: ev.testedSlotBinding,
    testedOperatingConditions: normalizeScalarMap(ev.testedOperatingConditions),
    recordedOutcome: ev.recordedOutcome,
    approvalStatus: ev.approvalStatus
  };
}

function normalizeCarryForwardRule(rule: CarryForwardRule): unknown {
  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    obligationId: rule.obligationId,
    sourceEvidenceId: rule.sourceEvidenceId,
    approvalStatus: rule.approvalStatus,
    approvedByAccountId: rule.approvedByAccountId,
    changeableSlots: [...new Set(rule.changeableSlots)].sort(),
    changeableEnvelopeKeys: [...new Set(rule.changeableEnvelopeKeys)].sort(),
    envelopePredicate: rule.envelopePredicate,
    validityPredicate: rule.validityPredicate,
    requiresDispositionSignoff: rule.requiresDispositionSignoff
  };
}

export function materializeEffectiveCatalogState(
  catalog: FamilyCatalog,
  operations: readonly ChangeOperation[]
): {
  readonly variants: ProductVariant[];
  readonly edges: BomEffectivityEdge[];
} {
  const variantMap = new Map<string, ProductVariant>(
    catalog.variants.map((v) => [v.variantId, v])
  );
  const edgeMap = new Map<string, BomEffectivityEdge>(
    catalog.baselineBomEdges.map((e) => [e.edgeId, e])
  );

  for (const op of operations) {
    if (op.op === "UPSERT_EDGE") {
      edgeMap.set(op.edge.edgeId, op.edge);
    } else if (op.op === "REMOVE_EDGE") {
      edgeMap.delete(op.edgeId);
    } else if (op.op === "SET_VARIANT_ENVELOPE") {
      const existing = variantMap.get(op.variantId);
      if (existing) {
        variantMap.set(op.variantId, {
          ...existing,
          operatingEnvelope: op.operatingEnvelope
        });
      }
    }
  }

  const variants = [...variantMap.values()].sort((a, b) =>
    a.variantId.localeCompare(b.variantId)
  );
  const edges = [...edgeMap.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return { variants, edges };
}

/**
 * Pure content-addressable snapshot digest (RFC 8785 SHA-256).
 * Note: Intentionally excludes approvalGeneration so content identity H1 == H1 is
 * testable on state restoration, while RoleAttestation separately binds BOTH
 * snapshotSha256 AND monotonic approvalGeneration to defeat H1 -> H2 -> H1 ABA reuse.
 */
export function computeSnapshotSha256(params: {
  readonly catalog: FamilyCatalog;
  readonly eco: Pick<EcoMetadata, "ecoJiraIssueId" | "authorAccountId">;
  readonly proposedOperations: readonly ChangeOperation[];
  readonly liveVerificationIssuesById: Readonly<Record<string, LiveJiraIssueProjection>>;
}): string {
  const { catalog, eco, proposedOperations, liveVerificationIssuesById } = params;
  const effective = materializeEffectiveCatalogState(catalog, proposedOperations);

  const canonicalProjection = {
    specFormatVersion: 2,
    familyId: catalog.familyId,
    rootAssemblyRevId: catalog.rootAssemblyRevId,
    policy: {
      policyId: catalog.policy.policyId,
      policyVersion: catalog.policy.policyVersion,
      requiredAttestationRoles: [...new Set(catalog.policy.requiredAttestationRoles)].sort(),
      carryForwardDispositionRole: catalog.policy.carryForwardDispositionRole ?? null,
      enforceSeparationOfDuties: catalog.policy.enforceSeparationOfDuties,
      allowRuleBasedCarryForward: catalog.policy.allowRuleBasedCarryForward
    },
    ecoIdentity: {
      ecoJiraIssueId: eco.ecoJiraIssueId,
      authorAccountId: eco.authorAccountId
    },
    variants: effective.variants.map(normalizeVariant),
    itemRevisions: [...catalog.itemRevisions]
      .sort((a, b) => a.itemRevId.localeCompare(b.itemRevId))
      .map(normalizeItemRevision),
    effectiveBomEdges: effective.edges.map(normalizeEdge),
    obligations: [...catalog.obligations]
      .sort((a, b) => a.obligationId.localeCompare(b.obligationId))
      .map(normalizeObligation),
    evidenceBindings: [...catalog.evidenceRecords]
      .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))
      .map((ev) => normalizeEvidence(ev, liveVerificationIssuesById)),
    carryForwardRules: [...catalog.carryForwardRules]
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId))
      .map(normalizeCarryForwardRule),
    retestDominanceRules: [...(catalog.retestDominanceRules ?? [])]
      .sort((a, b) => a.dominanceRuleId.localeCompare(b.dominanceRuleId))
      .map((r) => ({
        dominanceRuleId: r.dominanceRuleId,
        obligationId: r.obligationId,
        approvalStatus: r.approvalStatus,
        coveringVariantId: r.coveringVariantId,
        coveredVariantIds: [...new Set(r.coveredVariantIds)].sort()
      }))
  };

  return sha256Hex(canonicalizeJson(canonicalProjection));
}
