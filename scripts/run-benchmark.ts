import { performance } from "node:perf_hooks";
import {
  canonicalizeJson,
  evaluateB0TimestampStatus,
  evaluateB1UntypedSuspectGraph,
  evaluateB2CompetentVersionAndEnvelope,
  qty,
  verifyEngineeringChange,
  type BomEffectivityEdge,
  type FamilyCatalog,
  type ItemRevision,
  type VerificationInput
} from "../src/core/index";
import { buildLabeledBenchmarkCorpus } from "../src/scenarios/counterexamples";
import { createHeliosVerificationInput } from "../src/scenarios/heliosBatteryPack";

interface MethodMetrics {
  readonly method: string;
  totalAssertions: number;
  exactMatches: number;
  falseSafeCount: number;
  falseBlockCount: number;
  falseSafeCases: string[];
  falseBlockCases: string[];
}

function createMetrics(method: string): MethodMetrics {
  return {
    method,
    totalAssertions: 0,
    exactMatches: 0,
    falseSafeCount: 0,
    falseBlockCount: 0,
    falseSafeCases: [],
    falseBlockCases: []
  };
}

function recordOutcome(
  m: MethodMetrics,
  caseLabel: string,
  expectedSupported: boolean,
  predictedSupported: boolean
): void {
  m.totalAssertions += 1;
  if (expectedSupported === predictedSupported) {
    m.exactMatches += 1;
  } else if (!expectedSupported && predictedSupported) {
    m.falseSafeCount += 1;
    m.falseSafeCases.push(caseLabel);
  } else {
    m.falseBlockCount += 1;
    m.falseBlockCases.push(caseLabel);
  }
}

function buildSyntheticScaledInput(componentCount: number): VerificationInput {
  const base = createHeliosVerificationInput();
  const extraItems: ItemRevision[] = [];
  const extraEdges: BomEffectivityEdge[] = [];
  const extraExcluded: {
    readonly slotPath: string;
    readonly justification: string;
    readonly approvedByAccountId: string;
  }[] = [];

  for (let i = 1; i <= componentCount; i++) {
    const slotKey = `CELL_SENSE_R${i}`;
    const revA = `RES-SENSE-${i}@A`;
    extraItems.push({
      itemRevId: revA,
      partNumber: `RES-SENSE-${i}`,
      revision: "A",
      title: `Cell Sense Resistor ${i}`,
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: { resistance: qty(100, 0, "Ohm") }
    });
    extraExcluded.push({
      slotPath: slotKey,
      justification: "Passive sense resistor isolated by current-limiting fuse.",
      approvedByAccountId: "acct-safety-lead"
    });

    const bands: readonly [number, number | null][] = [
      [1000, 2000],
      [2000, 3500],
      [3500, 5000],
      [5000, null]
    ];
    for (let b = 0; b < bands.length; b++) {
      const [sFrom, sTo] = bands[b]!;
      extraEdges.push({
        edgeId: `E-SYNTH-${i}-B${b}`,
        parentItemRevId: "PACK-HELIOS@A",
        slotKey,
        childItemRevId: revA,
        variantScope: "ALL",
        serialFrom: sFrom,
        serialTo: sTo
      });
    }
  }

  const updatedObligations = base.catalog.obligations.map((obl) => ({
    ...obl,
    excludedSlots: [...obl.excludedSlots, ...extraExcluded]
  }));

  const scaledCatalog: FamilyCatalog = {
    ...base.catalog,
    itemRevisions: [...base.catalog.itemRevisions, ...extraItems],
    baselineBomEdges: [...base.catalog.baselineBomEdges, ...extraEdges],
    obligations: updatedObligations
  };

  return {
    ...base,
    catalog: scaledCatalog
  };
}

function main(): void {
  const suite = buildLabeledBenchmarkCorpus();
  const b0 = createMetrics("B0 (Timestamp & Done Status)");
  const b1 = createMetrics("B1 (Untyped Suspect Graph)");
  const b2 = createMetrics("B2 (Version + Serial + Standard Envelope)");
  const ll = createMetrics("LineLock v2 (Closed-World + K3 + Gen CAS)");

  const tSuiteStart = performance.now();

  for (const sc of suite) {
    const resB0 = evaluateB0TimestampStatus(sc.input);
    const resB1 = evaluateB1UntypedSuspectGraph(sc.input);
    const resB2 = evaluateB2CompetentVersionAndEnvelope(sc.input);
    const resLL = verifyEngineeringChange(sc.input);

    for (const [key, expectedSupported] of Object.entries(sc.expectedSliceObligationSupported)) {
      const [sliceId, obligationId] = key.split("::");
      if (!sliceId || !obligationId) {
        throw new Error(`Malformed assertion key "${key}" in ${sc.scenarioId}`);
      }

      const mB0 = resB0.find((r) => r.sliceId === sliceId && r.obligationId === obligationId);
      const mB1 = resB1.find((r) => r.sliceId === sliceId && r.obligationId === obligationId);
      const mB2 = resB2.find((r) => r.sliceId === sliceId && r.obligationId === obligationId);
      const mLL = resLL.sliceObligations.find(
        (r) => r.sliceId === sliceId && r.obligationId === obligationId
      );

      if (!mB0 || !mB1 || !mB2 || !mLL) {
        throw new Error(
          `Missing slice/obligation result for ${key} in scenario ${sc.scenarioId}`
        );
      }

      const label = `${sc.scenarioId}:${key}`;
      recordOutcome(b0, label, expectedSupported, mB0.verdict === "SUPPORTED");
      recordOutcome(b1, label, expectedSupported, mB1.verdict === "SUPPORTED");
      recordOutcome(b2, label, expectedSupported, mB2.verdict === "SUPPORTED");
      recordOutcome(
        ll,
        label,
        expectedSupported,
        mLL.status === "SUPPORTED_AS_TESTED" || mLL.status === "SUPPORTED_BY_APPROVED_RULE"
      );
    }
  }

  const suiteElapsedMs = performance.now() - tSuiteStart;

  console.log("=== LineLock Ground-Truth Verification Benchmark (16 Scenarios) ===");
  console.log(`Suite execution wall time: ${suiteElapsedMs.toFixed(2)} ms\n`);

  for (const m of [b0, b1, b2, ll]) {
    const accPct = ((m.exactMatches / m.totalAssertions) * 100).toFixed(1);
    console.log(
      `${m.method.padEnd(43)} | Exact: ${String(m.exactMatches).padStart(2)}/${m.totalAssertions} (${accPct.padStart(5)}%) | False-Safe: ${m.falseSafeCount} | False-Block: ${m.falseBlockCount}`
    );
    if (m.falseSafeCases.length > 0) {
      console.log(`  -> False-Safe : ${m.falseSafeCases.join(", ")}`);
    }
    if (m.falseBlockCases.length > 0) {
      console.log(`  -> False-Block: ${m.falseBlockCases.join(", ")}`);
    }
  }

  // Measure 503-edge & 807-edge scaling & storage payload footprint empirically
  const kvsLimitBytes = 240 * 1024;
  for (const compCount of [124, 200]) {
    const scaledInput = buildSyntheticScaledInput(compCount);
    const serializedPayloadBytes = Buffer.byteLength(
      canonicalizeJson(scaledInput.catalog),
      "utf8"
    );

    const latenciesMs: number[] = [];
    for (let iter = 0; iter < 15; iter++) {
      const t0 = performance.now();
      const out = verifyEngineeringChange(scaledInput);
      latenciesMs.push(performance.now() - t0);
      if (out.gateState !== "AWAITING_ATTESTATION") {
        throw new Error(
          `Unexpected gateState on scaled benchmark (${compCount}): ${out.gateState} (${out.blockingReasons[0] ?? ""})`
        );
      }
    }
    latenciesMs.sort((a, b) => a - b);
    const medianMs = latenciesMs[Math.floor(latenciesMs.length / 2)]!;
    const p95Ms =
      latenciesMs[Math.min(latenciesMs.length - 1, Math.ceil(latenciesMs.length * 0.95) - 1)]!;

    console.log(
      `\n=== Empirical Storage Footprint & Solver Latency (${scaledInput.catalog.baselineBomEdges.length} BOM Edges, Local Node v22 VM) ===`
    );
    console.log(
      `Canonical Catalog Payload : ${serializedPayloadBytes} bytes (${(serializedPayloadBytes / 1024).toFixed(1)} KiB)`
    );
    console.log(
      `Exceeds @forge/kvs 240KiB : ${serializedPayloadBytes > kvsLimitBytes} (${kvsLimitBytes} bytes limit)`
    );
    console.log(`15-run Median Latency     : ${medianMs.toFixed(2)} ms`);
    console.log(`15-run p95 Latency        : ${p95Ms.toFixed(2)} ms`);
  }

  if (ll.falseSafeCount !== 0 || ll.falseBlockCount !== 0) {
    process.exitCode = 1;
  }
}

main();
