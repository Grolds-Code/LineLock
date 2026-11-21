import { buildSerialScopedSubstitutionOps } from "../core/intervals.js";
import {
  boolVal,
  enumVal,
  qty,
  type ChangeOperation,
  type FamilyCatalog,
  type ItemRevision,
  type VerificationInput
} from "../core/types.js";
import {
  buildHeliosCapRevCSubstitution,
  createHeliosCatalog,
  createHeliosDefaultEco,
  createHeliosLiveIssues,
  createHeliosTrustedRoles
} from "./heliosBatteryPack.js";

export interface LabeledBenchmarkScenario {
  readonly scenarioId: string;
  readonly title: string;
  readonly input: VerificationInput;
  readonly expectedSliceObligationSupported: Readonly<Record<string, boolean>>;
}

function baseSetup(): {
  liveIssues: ReturnType<typeof createHeliosLiveIssues>;
  catalog: FamilyCatalog;
} {
  const liveIssues = createHeliosLiveIssues();
  const catalog = createHeliosCatalog(liveIssues);
  return { liveIssues, catalog };
}

/** CE-01: Spec-dominant component substituted WITHOUT an approved CarryForwardRule */
export function buildCE01NoApprovedRule(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const superCap: ItemRevision = {
    itemRevId: "CAP-1210@S_SUPER",
    partNumber: "CAP-1210-HV",
    revision: "S",
    title: "1210 MLCC 1200V C0G 8mOhm",
    itemKind: "COMPONENT",
    specStatus: "APPROVED",
    attributes: {
      v_rated: qty(1200, 0, "V"),
      esr: qty(8, 0, "mOhm"),
      dielectric: enumVal("C0G"),
      min_temp_rated: qty(-40, 0, "degC"),
      halogen_free: boolVal(true)
    }
  };
  const modifiedCatalog: FamilyCatalog = {
    ...catalog,
    itemRevisions: [...catalog.itemRevisions, superCap],
    carryForwardRules: []
  };
  const ops = buildSerialScopedSubstitutionOps({
    currentEdges: modifiedCatalog.baselineBomEdges,
    allVariantIds: ["VAR_400V", "VAR_800V"],
    parentItemRevId: "HV_INV@A",
    slotKey: "DC_LINK_CAP_C14",
    newChildItemRevId: "CAP-1210@S_SUPER",
    newEdgeIdPrefix: "CE01",
    targetVariants: ["VAR_400V"],
    serialFrom: 5000,
    serialTo: null
  });
  return {
    catalog: modifiedCatalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: ops,
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/** CE-02: Coupled unlisted governed slot mutation (C14 + U3 simultaneously) */
export function buildCE02CoupledUnlistedSlot(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const capOps = buildSerialScopedSubstitutionOps({
    currentEdges: catalog.baselineBomEdges,
    allVariantIds: ["VAR_400V", "VAR_800V"],
    parentItemRevId: "HV_INV@A",
    slotKey: "DC_LINK_CAP_C14",
    newChildItemRevId: "CAP-1210@C",
    newEdgeIdPrefix: "CE02-CAP",
    targetVariants: ["VAR_400V"],
    serialFrom: 5000,
    serialTo: null
  });
  const drvOps = buildSerialScopedSubstitutionOps({
    currentEdges: catalog.baselineBomEdges,
    allVariantIds: ["VAR_400V", "VAR_800V"],
    parentItemRevId: "HV_INV@A",
    slotKey: "GATE_DRIVER_U3",
    newChildItemRevId: "DRV-ISO@B",
    newEdgeIdPrefix: "CE02-DRV",
    targetVariants: ["VAR_400V"],
    serialFrom: 5000,
    serialTo: null
  });
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: [...capOps, ...drvOps],
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/** CE-03: Negated missing attribute (!UNKNOWN == UNKNOWN) */
export function buildCE03NegatedMissingAttribute(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const missingHalogenCap: ItemRevision = {
    itemRevId: "CAP-1210@M_NO_HALOGEN",
    partNumber: "CAP-1210-HV",
    revision: "M",
    title: "1210 MLCC 630V X7R 10mOhm (Missing halogen_free)",
    itemKind: "COMPONENT",
    specStatus: "APPROVED",
    attributes: {
      v_rated: qty(630, 0, "V"),
      esr: qty(10, 0, "mOhm"),
      dielectric: enumVal("X7R")
    }
  };
  const modifiedCatalog: FamilyCatalog = {
    ...catalog,
    itemRevisions: [...catalog.itemRevisions, missingHalogenCap]
  };
  const ops = buildSerialScopedSubstitutionOps({
    currentEdges: modifiedCatalog.baselineBomEdges,
    allVariantIds: ["VAR_400V", "VAR_800V"],
    parentItemRevId: "HV_INV@A",
    slotKey: "DC_LINK_CAP_C14",
    newChildItemRevId: "CAP-1210@M_NO_HALOGEN",
    newEdgeIdPrefix: "CE03",
    targetVariants: ["VAR_400V"],
    serialFrom: 5000,
    serialTo: null
  });
  return {
    catalog: modifiedCatalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: ops,
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/** CE-04: Unit mismatch (10 Ohm vs <= 15 mOhm) */
export function buildCE04UnitMismatch(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const badUnitCap: ItemRevision = {
    itemRevId: "CAP-1210@U_OHM",
    partNumber: "CAP-1210-HV",
    revision: "U",
    title: "1210 Capacitor 630V X7R 10 Ohm",
    itemKind: "COMPONENT",
    specStatus: "APPROVED",
    attributes: {
      v_rated: qty(630, 0, "V"),
      esr: qty(10, 0, "Ohm"),
      dielectric: enumVal("X7R"),
      halogen_free: boolVal(true)
    }
  };
  const modifiedCatalog: FamilyCatalog = {
    ...catalog,
    itemRevisions: [...catalog.itemRevisions, badUnitCap]
  };
  const ops = buildSerialScopedSubstitutionOps({
    currentEdges: modifiedCatalog.baselineBomEdges,
    allVariantIds: ["VAR_400V", "VAR_800V"],
    parentItemRevId: "HV_INV@A",
    slotKey: "DC_LINK_CAP_C14",
    newChildItemRevId: "CAP-1210@U_OHM",
    newEdgeIdPrefix: "CE04",
    targetVariants: ["VAR_400V"],
    serialFrom: 5000,
    serialTo: null
  });
  return {
    catalog: modifiedCatalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: ops,
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/** CE-05: Upper operating-envelope shift (max_ambient 55C -> 75C) with unchanged BOM */
export function buildCE05UpperEnvelopeShift(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const ops: ChangeOperation[] = [
    {
      op: "SET_VARIANT_ENVELOPE",
      variantId: "VAR_400V",
      operatingEnvelope: {
        bus_voltage: qty(400, 0, "V"),
        max_ambient: qty(75, 0, "degC"),
        min_ambient: qty(-20, 0, "degC"),
        aux_rail_voltage: qty(12, 0, "V")
      }
    }
  ];
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: ops,
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/** CE-06: Diamond BOM placement (CAP-1210@C valid in 12V Aux, defeated in 800V HV) */
export function buildCE06DiamondPlacement(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const hvOps = buildHeliosCapRevCSubstitution(catalog, ["VAR_800V"], 5000);
  const auxOps = buildSerialScopedSubstitutionOps({
    currentEdges: catalog.baselineBomEdges,
    allVariantIds: ["VAR_400V", "VAR_800V"],
    parentItemRevId: "AUX_12V@A",
    slotKey: "FILTER_CAP_C1",
    newChildItemRevId: "CAP-1210@C",
    newEdgeIdPrefix: "CE06-AUX",
    targetVariants: ["VAR_800V"],
    serialFrom: 5000,
    serialTo: null
  });
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: [...hvOps, ...auxOps],
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/** CE-07: Overlapping serial effectivity [1000, +inf) and [5000, +inf) */
export function buildCE07OverlappingEffectivity(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: [
      {
        op: "UPSERT_EDGE",
        edge: {
          edgeId: "E-UNSPLIT-OVERLAP",
          parentItemRevId: "HV_INV@A",
          slotKey: "DC_LINK_CAP_C14",
          childItemRevId: "CAP-1210@C",
          variantScope: ["VAR_400V"],
          serialFrom: 5000,
          serialTo: null
        }
      }
    ],
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/** CE-08: Post-approval Jira test issue content drift with fresh updatedAt timestamp */
export function buildCE08DriftedJiraEvidence(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: [],
    liveVerificationIssuesById: {
      ...liveIssues,
      "10102": {
        ...liveIssues["10102"]!,
        description: "Edited post-approval: reduced test voltage to 500V during bench run.",
        updatedAtEpochMs: liveIssues["10102"]!.updatedAtEpochMs + 300_000
      }
    },
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/**
 * CE-09 (Issue #1): Partial testedSlotBinding omission!
 * EV-400-RIPPLE omits governed slot "HV_INV/GATE_DRIVER_U3" from testedSlotBinding, and
 * GATE_DRIVER_U3 was actually changed to DRV-ISO@B in baseline/ECO.
 * Strengthened B2 checks only keys present in EV-400-RIPPLE.testedSlotBinding and FALSELY APPROVES!
 * LineLock rejects EV-400-RIPPLE with INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT.
 */
export function buildCE09IncompleteEvidenceFootprint(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const partialCatalog: FamilyCatalog = {
    ...catalog,
    evidenceRecords: catalog.evidenceRecords.map((ev) =>
      ev.evidenceId === "EV-400-RIPPLE"
        ? {
            ...ev,
            // Omitted HV_INV/GATE_DRIVER_U3 from testedSlotBinding!
            testedSlotBinding: {
              "HV_INV/DC_LINK_CAP_C14": "CAP-1210@B"
            }
          }
        : ev
    )
  };
  return {
    catalog: partialCatalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: [],
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/**
 * CE-10 (Issue #1): Unexamined new BOM component added by ECO!
 * ECO introduces HV_INV/SNUBBER_R9 (not listed in governedSlotPaths OR excludedSlots).
 * Strengthened B2 sees all existing testedSlotBinding keys match and FALSELY APPROVES!
 * LineLock blocks with INDETERMINATE_UNEXAMINED_DEPENDENCY.
 */
export function buildCE10UnexaminedNewBomSlot(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  const snubberResistor: ItemRevision = {
    itemRevId: "RES-SNUB@A",
    partNumber: "RES-SNUB-10R",
    revision: "A",
    title: "HV Snubber Resistor 10 Ohm",
    itemKind: "COMPONENT",
    specStatus: "APPROVED",
    attributes: { resistance: qty(10, 0, "Ohm") }
  };
  const nextCatalog: FamilyCatalog = {
    ...catalog,
    itemRevisions: [...catalog.itemRevisions, snubberResistor]
  };
  const ops: ChangeOperation[] = [
    {
      op: "UPSERT_EDGE",
      edge: {
        edgeId: "E-NEW-SNUBBER-R9",
        parentItemRevId: "HV_INV@A",
        slotKey: "SNUBBER_R9",
        childItemRevId: "RES-SNUB@A",
        variantScope: ["VAR_400V"],
        serialFrom: 5000,
        serialTo: null
      }
    }
  ];
  return {
    catalog: nextCatalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: ops,
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/**
 * CE-11a (Issue #5 & #6): Same-revision cold-soak lower-bound violation!
 * Zero BOM component changes (CAP-1210@B unchanged), but Variant-400V min_ambient drops from
 * -20 degC to -40 degC (arctic fleet deployment).
 * Strengthened B2's standard upper-bound envelope check (-40 <= -20) FALSELY APPROVES!
 * LineLock detects divergence from tested -20 degC and falsifies CFR-400-CAP-SUB's min_ambient >= -30 degC!
 */
export function buildCE11aSameRevColdSoakRegression(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: [
      {
        op: "SET_VARIANT_ENVELOPE",
        variantId: "VAR_400V",
        operatingEnvelope: {
          bus_voltage: qty(400, 0, "V"),
          max_ambient: qty(55, 0, "degC"),
          min_ambient: qty(-40, 0, "degC"),
          aux_rail_voltage: qty(12, 0, "V")
        }
      }
    ],
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

/**
 * CE-11b (Issue #5): Same-revision new unexamined environmental axis (coastal salt fog)!
 * Zero BOM component changes, existing envelope keys unchanged, but Variant-400V adds
 * salt_fog_exposure: true.
 * Strengthened B2 checks only keys in testedOperatingConditions and FALSELY APPROVES!
 * LineLock blocks with INDETERMINATE_UNEXAMINED_OPERATING_CONDITION.
 */
export function buildCE11bUnexaminedEnvironmentalAxis(): VerificationInput {
  const { liveIssues, catalog } = baseSetup();
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations: [
      {
        op: "SET_VARIANT_ENVELOPE",
        variantId: "VAR_400V",
        operatingEnvelope: {
          bus_voltage: qty(400, 0, "V"),
          max_ambient: qty(55, 0, "degC"),
          min_ambient: qty(-20, 0, "degC"),
          aux_rail_voltage: qty(12, 0, "V"),
          salt_fog_exposure: boolVal(true)
        }
      }
    ],
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}

export function buildLabeledBenchmarkCorpus(): LabeledBenchmarkScenario[] {
  const { liveIssues: baseIssues, catalog: baseCat } = baseSetup();

  const sc01Clean: VerificationInput = {
    catalog: baseCat,
    eco: createHeliosDefaultEco(),
    proposedOperations: [],
    liveVerificationIssuesById: baseIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };

  const sc02Eco204All: VerificationInput = {
    ...sc01Clean,
    proposedOperations: buildHeliosCapRevCSubstitution(baseCat, "ALL", 5000)
  };

  const sc03Eco204Scoped400: VerificationInput = {
    ...sc01Clean,
    proposedOperations: buildHeliosCapRevCSubstitution(baseCat, ["VAR_400V"], 5000)
  };

  // Same-revision warm ambient within rule envelope (55C -> 58C <= 60C on VAR_400V)
  const sc13SameRevApprovedWarmEnvelope: VerificationInput = {
    ...sc01Clean,
    proposedOperations: [
      {
        op: "SET_VARIANT_ENVELOPE",
        variantId: "VAR_400V",
        operatingEnvelope: {
          bus_voltage: qty(400, 0, "V"),
          max_ambient: qty(58, 0, "degC"),
          min_ambient: qty(-20, 0, "degC"),
          aux_rail_voltage: qty(12, 0, "V")
        }
      }
    ]
  };

  // Excluded mechanical seal change: OBL_THERM_RIPPLE & OBL_AUX_EMC explicitly unaffected, OBL_INGRESS invalidated
  const sc14ExcludedSealChange: VerificationInput = {
    ...sc01Clean,
    proposedOperations: buildSerialScopedSubstitutionOps({
      currentEdges: baseCat.baselineBomEdges,
      allVariantIds: ["VAR_400V", "VAR_800V"],
      parentItemRevId: "PACK-HELIOS@A",
      slotKey: "ENCLOSURE_SEAL_S1",
      newChildItemRevId: "SEAL-EPDM@B",
      newEdgeIdPrefix: "SC14-SEAL",
      targetVariants: ["VAR_400V"],
      serialFrom: 3000,
      serialTo: null
    })
  };

  return [
    {
      scenarioId: "SC-01",
      title: "Clean Baseline (All Variants SN 1000..+inf)",
      input: sc01Clean,
      expectedSliceObligationSupported: {
        "VAR_400V@1000..INF::OBL_THERM_RIPPLE": true,
        "VAR_400V@1000..INF::OBL_AUX_EMC": true,
        "VAR_400V@1000..INF::OBL_INGRESS": true,
        "VAR_800V@1000..INF::OBL_THERM_RIPPLE": true,
        "VAR_800V@1000..INF::OBL_AUX_EMC": true,
        "VAR_800V@1000..INF::OBL_INGRESS": true
      }
    },
    {
      scenarioId: "SC-02",
      title: "Helios ECO-204: Cap Rev B->C at SN>=5000 (400V Rule Valid, 800V Defeated)",
      input: sc02Eco204All,
      expectedSliceObligationSupported: {
        "VAR_400V@1000..5000::OBL_THERM_RIPPLE": true,
        "VAR_400V@5000..INF::OBL_THERM_RIPPLE": true,
        "VAR_800V@1000..5000::OBL_THERM_RIPPLE": true,
        "VAR_800V@5000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-03",
      title: "Scoped Cap Rev B->C ONLY on 400V SN>=5000 (Rule-Authorized Carry-Forward)",
      input: sc03Eco204Scoped400,
      expectedSliceObligationSupported: {
        "VAR_400V@1000..5000::OBL_THERM_RIPPLE": true,
        "VAR_400V@5000..INF::OBL_THERM_RIPPLE": true,
        "VAR_800V@1000..INF::OBL_THERM_RIPPLE": true
      }
    },
    {
      scenarioId: "SC-04 (CE-01)",
      title: "Spec-Dominant Part Without Approved CarryForwardRule",
      input: buildCE01NoApprovedRule(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..5000::OBL_THERM_RIPPLE": true,
        "VAR_400V@5000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-05 (CE-02)",
      title: "Coupled Unlisted Governed Slot Mutation (Cap C14 + Gate Driver U3)",
      input: buildCE02CoupledUnlistedSlot(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..5000::OBL_THERM_RIPPLE": true,
        "VAR_400V@5000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-06 (CE-03)",
      title: "Negated Missing Attribute (!UNKNOWN == UNKNOWN)",
      input: buildCE03NegatedMissingAttribute(),
      expectedSliceObligationSupported: {
        "VAR_400V@5000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-07 (CE-04)",
      title: "Dimensional Unit Mismatch (10 Ohm vs <= 15 mOhm)",
      input: buildCE04UnitMismatch(),
      expectedSliceObligationSupported: {
        "VAR_400V@5000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-08 (CE-05)",
      title: "Upper Operating Envelope Exceeded (75C > 60C) With Unchanged BOM",
      input: buildCE05UpperEnvelopeShift(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..INF::OBL_THERM_RIPPLE": false,
        "VAR_400V@1000..INF::OBL_INGRESS": false
      }
    },
    {
      scenarioId: "SC-09 (CE-06)",
      title: "Diamond BOM Placement (Same Part Valid in 12V Aux, Defeated in 800V HV)",
      input: buildCE06DiamondPlacement(),
      expectedSliceObligationSupported: {
        "VAR_800V@5000..INF::OBL_AUX_EMC": true,
        "VAR_800V@5000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-10 (CE-08)",
      title: "Post-Approval Jira Test Issue Content Drift With Fresh Timestamp",
      input: buildCE08DriftedJiraEvidence(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..INF::OBL_THERM_RIPPLE": true,
        "VAR_800V@1000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-11 (CE-09)",
      title: "Partial Evidence Footprint Omission (Missing Governed Slot in testedSlotBinding)",
      input: buildCE09IncompleteEvidenceFootprint(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-12 (CE-10)",
      title: "Unexamined New BOM Slot Introduced by ECO (SNUBBER_R9)",
      input: buildCE10UnexaminedNewBomSlot(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..5000::OBL_THERM_RIPPLE": true,
        "VAR_400V@5000..INF::OBL_THERM_RIPPLE": false
      }
    },
    {
      scenarioId: "SC-13 (CE-11a)",
      title: "Same-Revision Cold-Soak Lower-Bound Regression (-40C vs Tested -20C)",
      input: buildCE11aSameRevColdSoakRegression(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..INF::OBL_THERM_RIPPLE": false,
        "VAR_400V@1000..INF::OBL_INGRESS": false
      }
    },
    {
      scenarioId: "SC-14 (CE-11b)",
      title: "Same-Revision Unexamined Environmental Axis Added (salt_fog_exposure)",
      input: buildCE11bUnexaminedEnvironmentalAxis(),
      expectedSliceObligationSupported: {
        "VAR_400V@1000..INF::OBL_THERM_RIPPLE": false,
        "VAR_400V@1000..INF::OBL_INGRESS": false
      }
    },
    {
      scenarioId: "SC-15",
      title: "Same-Revision Warm Ambient Within Rule Envelope (55C->58C: Ripple Rule Valid, IP67 Retest Required)",
      input: sc13SameRevApprovedWarmEnvelope,
      expectedSliceObligationSupported: {
        "VAR_400V@1000..INF::OBL_THERM_RIPPLE": true, // CFR-400-CAP-SUB allows max_ambient <= 60C
        "VAR_400V@1000..INF::OBL_INGRESS": false // OBL_INGRESS is RETEST_REQUIRED on any condition change!
      }
    },
    {
      scenarioId: "SC-16",
      title: "Justified Excluded Slot Change (Seal Rev B: Ripple Unaffected, IP67 Blocked)",
      input: sc14ExcludedSealChange,
      expectedSliceObligationSupported: {
        "VAR_400V@3000..INF::OBL_THERM_RIPPLE": true,
        "VAR_400V@3000..INF::OBL_AUX_EMC": true,
        "VAR_400V@3000..INF::OBL_INGRESS": false
      }
    }
  ];
}
