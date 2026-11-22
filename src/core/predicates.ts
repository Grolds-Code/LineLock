import type {
  ItemRevision,
  NumericTerm,
  PredicateExpr,
  PredicateTraceNode,
  ScalarValue,
  TruthValue,
  ValueRef
} from "./types";

export interface PredicateEvalContext {
  readonly resolvedSlotBindings: Readonly<Record<string, string>>;
  readonly itemRevisionsById: ReadonlyMap<string, ItemRevision>;
  readonly variantEnvelope: Readonly<Record<string, ScalarValue>>;
  readonly testedOperatingConditions: Readonly<Record<string, ScalarValue>>;
}

export interface ExactQuantity {
  readonly mantissa: bigint;
  readonly scale: number;
  readonly unit: string;
}

type ResolvedTerm<T> =
  | { readonly ok: true; readonly value: T; readonly label: string }
  | { readonly ok: false; readonly reason: string };

function pow10BigInt(exp: number): bigint {
  if (exp < 0 || !Number.isSafeInteger(exp)) {
    throw new RangeError(`Exponent for pow10BigInt must be a non-negative safe integer, got ${exp}`);
  }
  return 10n ** BigInt(exp);
}

export function formatScalar(val: ScalarValue): string {
  if (val.kind === "boolean") {
    return String(val.value);
  }
  if (val.kind === "enum") {
    return JSON.stringify(val.value);
  }
  if (val.scale === 0) {
    return `${val.mantissa} ${val.unit}`;
  }
  return `${val.mantissa}e${val.scale} ${val.unit}`;
}

function formatExactQuantity(q: ExactQuantity): string {
  if (q.scale === 0) {
    return `${q.mantissa.toString(10)} ${q.unit}`;
  }
  return `${q.mantissa.toString(10)}e${q.scale} ${q.unit}`;
}

export function compareExactQuantities(
  a: ExactQuantity,
  b: ExactQuantity
): { readonly comparable: true; readonly cmp: -1 | 0 | 1 } | { readonly comparable: false; readonly reason: string } {
  if (a.unit !== b.unit) {
    return {
      comparable: false,
      reason: `Unit mismatch: cannot compare "${a.unit}" against "${b.unit}"`
    };
  }
  const minScale = Math.min(a.scale, b.scale);
  const lhs = a.mantissa * pow10BigInt(a.scale - minScale);
  const rhs = b.mantissa * pow10BigInt(b.scale - minScale);
  const cmp = lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  return { comparable: true, cmp };
}

export function scalarsExactEqual(a: ScalarValue | undefined, b: ScalarValue | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "boolean" && b.kind === "boolean") {
    return a.value === b.value;
  }
  if (a.kind === "enum" && b.kind === "enum") {
    return a.value === b.value;
  }
  if (a.kind === "quantity" && b.kind === "quantity") {
    const res = compareExactQuantities(
      { mantissa: BigInt(a.mantissa), scale: a.scale, unit: a.unit },
      { mantissa: BigInt(b.mantissa), scale: b.scale, unit: b.unit }
    );
    return res.comparable && res.cmp === 0;
  }
  return false;
}

function resolveValueRef(ref: ValueRef, ctx: PredicateEvalContext): ResolvedTerm<ScalarValue> {
  if (ref.source === "literal") {
    return { ok: true, value: ref.value, label: formatScalar(ref.value) };
  }
  if (ref.source === "variant_env") {
    const val = ctx.variantEnvelope[ref.envKey];
    if (!val) {
      return { ok: false, reason: `Missing variant operatingEnvelope attribute "${ref.envKey}"` };
    }
    return { ok: true, value: val, label: `variant.${ref.envKey}(${formatScalar(val)})` };
  }
  if (ref.source === "tested_env") {
    const val = ctx.testedOperatingConditions[ref.envKey];
    if (!val) {
      return {
        ok: false,
        reason: `Missing evidence testedOperatingConditions attribute "${ref.envKey}"`
      };
    }
    return { ok: true, value: val, label: `tested.${ref.envKey}(${formatScalar(val)})` };
  }
  const itemRevId = ctx.resolvedSlotBindings[ref.slotPath];
  if (!itemRevId) {
    return { ok: false, reason: `Slot path "${ref.slotPath}" is not present in effective slice` };
  }
  const item = ctx.itemRevisionsById.get(itemRevId);
  if (!item) {
    return { ok: false, reason: `ItemRevision "${itemRevId}" referenced by "${ref.slotPath}" not found` };
  }
  if (item.specStatus !== "APPROVED") {
    return {
      ok: false,
      reason: `ItemRevision "${itemRevId}" at "${ref.slotPath}" has specStatus "${item.specStatus}" (must be APPROVED)`
    };
  }
  const attr = item.attributes[ref.attrKey];
  if (!attr) {
    return {
      ok: false,
      reason: `Missing attribute "${ref.attrKey}" on approved ItemRevision "${itemRevId}" ("${ref.slotPath}")`
    };
  }
  return {
    ok: true,
    value: attr,
    label: `${ref.slotPath}[${itemRevId}].${ref.attrKey}(${formatScalar(attr)})`
  };
}

function isValueRef(term: NumericTerm): term is ValueRef {
  return "source" in term;
}

function resolveNumericTerm(term: NumericTerm, ctx: PredicateEvalContext): ResolvedTerm<ExactQuantity> {
  if (isValueRef(term)) {
    const resolved = resolveValueRef(term, ctx);
    if (!resolved.ok) {
      return resolved;
    }
    if (resolved.value.kind !== "quantity") {
      return {
        ok: false,
        reason: `Expected quantity for numeric term ${resolved.label}, got ${resolved.value.kind}`
      };
    }
    return {
      ok: true,
      value: {
        mantissa: BigInt(resolved.value.mantissa),
        scale: resolved.value.scale,
        unit: resolved.value.unit
      },
      label: resolved.label
    };
  }

  if (term.op === "SCALE") {
    if (!Number.isSafeInteger(term.factorMantissa) || !Number.isSafeInteger(term.factorScale)) {
      return { ok: false, reason: "Non-integer scale factor in SCALE term" };
    }
    const base = resolveNumericTerm(term.arg, ctx);
    if (!base.ok) {
      return base;
    }
    const scaled: ExactQuantity = {
      mantissa: base.value.mantissa * BigInt(term.factorMantissa),
      scale: base.value.scale + term.factorScale,
      unit: base.value.unit
    };
    const factorStr =
      term.factorScale === 0 ? `${term.factorMantissa}` : `${term.factorMantissa}e${term.factorScale}`;
    return {
      ok: true,
      value: scaled,
      label: `(${factorStr} * ${base.label} = ${formatExactQuantity(scaled)})`
    };
  }

  const lhs = resolveNumericTerm(term.left, ctx);
  if (!lhs.ok) return lhs;
  const rhs = resolveNumericTerm(term.right, ctx);
  if (!rhs.ok) return rhs;
  if (lhs.value.unit !== rhs.value.unit) {
    return {
      ok: false,
      reason: `Unit mismatch in ${term.kind}: "${lhs.value.unit}" vs "${rhs.value.unit}"`
    };
  }
  const minScale = Math.min(lhs.value.scale, rhs.value.scale);
  const normL = lhs.value.mantissa * pow10BigInt(lhs.value.scale - minScale);
  const normR = rhs.value.mantissa * pow10BigInt(rhs.value.scale - minScale);
  const combined: ExactQuantity = {
    mantissa: term.kind === "ADD" ? normL + normR : normL - normR,
    scale: minScale,
    unit: lhs.value.unit
  };
  const sym = term.kind === "ADD" ? "+" : "-";
  return {
    ok: true,
    value: combined,
    label: `(${lhs.label} ${sym} ${rhs.label} = ${formatExactQuantity(combined)})`
  };
}

export function kleeneNot(v: TruthValue): TruthValue {
  if (v === "TRUE") return "FALSE";
  if (v === "FALSE") return "TRUE";
  return "UNKNOWN";
}

export function kleeneAnd(values: readonly TruthValue[]): TruthValue {
  if (values.length === 0) return "UNKNOWN";
  let sawUnknown = false;
  for (const v of values) {
    if (v === "FALSE") return "FALSE";
    if (v === "UNKNOWN") sawUnknown = true;
  }
  return sawUnknown ? "UNKNOWN" : "TRUE";
}

export function kleeneOr(values: readonly TruthValue[]): TruthValue {
  if (values.length === 0) return "UNKNOWN";
  let sawUnknown = false;
  for (const v of values) {
    if (v === "TRUE") return "TRUE";
    if (v === "UNKNOWN") sawUnknown = true;
  }
  return sawUnknown ? "UNKNOWN" : "FALSE";
}

export function evaluatePredicateK3(
  expr: PredicateExpr,
  ctx: PredicateEvalContext
): PredicateTraceNode {
  switch (expr.kind) {
    case "CMP_NUM": {
      const left = resolveNumericTerm(expr.left, ctx);
      if (!left.ok) return { exprKind: "CMP_NUM", value: "UNKNOWN", reason: left.reason };
      const right = resolveNumericTerm(expr.right, ctx);
      if (!right.ok) return { exprKind: "CMP_NUM", value: "UNKNOWN", reason: right.reason };
      const cmpRes = compareExactQuantities(left.value, right.value);
      if (!cmpRes.comparable) {
        return { exprKind: "CMP_NUM", value: "UNKNOWN", reason: cmpRes.reason };
      }
      const c = cmpRes.cmp;
      const matched =
        (expr.cmp === "EQ" && c === 0) ||
        (expr.cmp === "LTE" && c <= 0) ||
        (expr.cmp === "LT" && c < 0) ||
        (expr.cmp === "GTE" && c >= 0) ||
        (expr.cmp === "GT" && c > 0);
      return {
        exprKind: "CMP_NUM",
        value: matched ? "TRUE" : "FALSE",
        reason: `${left.label} ${expr.cmp} ${right.label} => ${matched ? "TRUE" : "FALSE"}`
      };
    }
    case "CMP_ENUM": {
      const resolved = resolveValueRef(expr.ref, ctx);
      if (!resolved.ok) return { exprKind: "CMP_ENUM", value: "UNKNOWN", reason: resolved.reason };
      if (resolved.value.kind !== "enum") {
        return {
          exprKind: "CMP_ENUM",
          value: "UNKNOWN",
          reason: `Expected enum at ${resolved.label}, got ${resolved.value.kind}`
        };
      }
      const matched =
        expr.cmp === "EQ"
          ? expr.allowed.length === 1 && resolved.value.value === expr.allowed[0]
          : expr.allowed.includes(resolved.value.value);
      return {
        exprKind: "CMP_ENUM",
        value: matched ? "TRUE" : "FALSE",
        reason: `${resolved.label} ${expr.cmp} [${expr.allowed.join(", ")}] => ${matched ? "TRUE" : "FALSE"}`
      };
    }
    case "CMP_BOOL": {
      const resolved = resolveValueRef(expr.ref, ctx);
      if (!resolved.ok) return { exprKind: "CMP_BOOL", value: "UNKNOWN", reason: resolved.reason };
      if (resolved.value.kind !== "boolean") {
        return {
          exprKind: "CMP_BOOL",
          value: "UNKNOWN",
          reason: `Expected boolean at ${resolved.label}, got ${resolved.value.kind}`
        };
      }
      const matched = resolved.value.value === expr.expected;
      return {
        exprKind: "CMP_BOOL",
        value: matched ? "TRUE" : "FALSE",
        reason: `${resolved.label} === ${String(expr.expected)} => ${matched ? "TRUE" : "FALSE"}`
      };
    }
    case "NOT": {
      const child = evaluatePredicateK3(expr.arg, ctx);
      const val = kleeneNot(child.value);
      return {
        exprKind: "NOT",
        value: val,
        reason: `NOT(${child.value}) => ${val}: ${child.reason}`,
        children: [child]
      };
    }
    case "AND": {
      if (expr.args.length === 0) {
        return { exprKind: "AND", value: "UNKNOWN", reason: "Empty AND conjunction is indeterminate" };
      }
      const children = expr.args.map((a) => evaluatePredicateK3(a, ctx));
      const val = kleeneAnd(children.map((c) => c.value));
      const summary =
        val === "FALSE"
          ? children.filter((c) => c.value === "FALSE").map((c) => c.reason).join("; ")
          : val === "UNKNOWN"
            ? children.filter((c) => c.value === "UNKNOWN").map((c) => c.reason).join("; ")
            : "All conjuncts satisfied";
      return { exprKind: "AND", value: val, reason: summary, children };
    }
    case "OR": {
      if (expr.args.length === 0) {
        return { exprKind: "OR", value: "UNKNOWN", reason: "Empty OR disjunction is indeterminate" };
      }
      const children = expr.args.map((a) => evaluatePredicateK3(a, ctx));
      const val = kleeneOr(children.map((c) => c.value));
      const summary =
        val === "TRUE"
          ? children.filter((c) => c.value === "TRUE").map((c) => c.reason).join("; ")
          : children.map((c) => c.reason).join("; ");
      return { exprKind: "OR", value: val, reason: summary, children };
    }
  }
}
