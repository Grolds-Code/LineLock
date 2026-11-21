import { computePinnedIssueStateHash } from "../core/canonical.js";
import { buildSerialScopedSubstitutionOps } from "../core/intervals.js";
import {
  boolVal,
  enumVal,
  qty,
  type CarryForwardRule,
  type ChangeOperation,
  type EcoMetadata,
  type FamilyCatalog,
  type ItemRevision,
  type LiveJiraIssueProjection,
  type VerificationEvidence,
  type VerificationInput
} from "../core/types.js";

export const HELIOS_BASE_EPOCH_MS = 1_795_000_000_000;

export function createHeliosLiveIssues(): Record<string, LiveJiraIssueProjection> {
  const issues: LiveJiraIssueProjection[] = [
    {
      issueId: "10101",
      issueKey: "VER-101",
      summary: "400V Commuter Pack HV DC-Link Thermal Ripple Qualification",
      description:
        "Validated HV_INV/DC_LINK_CAP_C14=CAP-1210@B and HV_INV/GATE_DRIVER_U3=DRV-ISO@A at 400V, [-20C..55C].",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 60_000,
      structuredFields: {
        peak_temp_c: qty(71, 0, "degC"),
        bus_test_v: qty(400, 0, "V")
      }
    },
    {
      issueId: "10102",
      issueKey: "VER-102",
      summary: "800V HyperCharge Pack HV DC-Link Fast-Charge Ripple Qualification",
      description:
        "Validated HV_INV/DC_LINK_CAP_C14=CAP-1210@B (C0G 1000V) and HV_INV/GATE_DRIVER_U3=DRV-ISO@A at 800V, [-20C..60C].",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 120_000,
      structuredFields: {
        peak_temp_c: qty(79, 0, "degC"),
        bus_test_v: qty(800, 0, "V")
      }
    },
    {
      issueId: "10103",
      issueKey: "VER-103",
      summary: "12V Auxiliary Rail Conducted Emissions Qualification (400V)",
      description: "Validated AUX_12V/FILTER_CAP_C1=CAP-1210@B at 12V rail on 400V pack.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 30_000,
      structuredFields: { margin_db: qty(8, 0, "dBuV") }
    },
    {
      issueId: "10104",
      issueKey: "VER-104",
      summary: "12V Auxiliary Rail Conducted Emissions Qualification (800V)",
      description: "Validated AUX_12V/FILTER_CAP_C1=CAP-1210@B at 12V rail on 800V pack.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 30_000,
      structuredFields: { margin_db: qty(7, 0, "dBuV") }
    },
    {
      issueId: "10105",
      issueKey: "VER-105",
      summary: "IP67 Immersion & Pressure Decay Enclosure Qualification (400V)",
      description: "Validated ENCLOSURE_SEAL_S1=SEAL-EPDM@A on 400V pack [-20C..55C].",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 10_000,
      structuredFields: { leak_rate: qty(2, -2, "cc_min") }
    },
    {
      issueId: "10106",
      issueKey: "VER-106",
      summary: "IP67 Immersion & Pressure Decay Enclosure Qualification (800V)",
      description: "Validated ENCLOSURE_SEAL_S1=SEAL-EPDM@A on 800V pack [-20C..60C].",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 10_000,
      structuredFields: { leak_rate: qty(2, -2, "cc_min") }
    }
  ];

  const byId: Record<string, LiveJiraIssueProjection> = {};
  for (const issue of issues) {
    byId[issue.issueId] = issue;
  }
  return byId;
}

export function createHeliosCatalog(
  liveIssuesById: Readonly<Record<string, LiveJiraIssueProjection>> = createHeliosLiveIssues()
): FamilyCatalog {
  const itemRevisions: ItemRevision[] = [
    {
      itemRevId: "PACK-HELIOS@A",
      partNumber: "PACK-HELIOS",
      revision: "A",
      title: "Helios Traction Battery Pack Assembly",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "HV_INV@A",
      partNumber: "HV-INV-MOD",
      revision: "A",
      title: "High-Voltage SiC Inverter Sub-Assembly",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "AUX_12V@A",
      partNumber: "AUX-12V-MOD",
      revision: "A",
      title: "12V Auxiliary Rail Buck Module",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "CAP-1210@B",
      partNumber: "CAP-1210-HV",
      revision: "B",
      title: "1210 MLCC Capacitor 1000V C0G 12mOhm",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        v_rated: qty(1000, 0, "V"),
        esr: qty(12, 0, "mOhm"),
        dielectric: enumVal("C0G"),
        min_temp_rated: qty(-40, 0, "degC"),
        halogen_free: boolVal(true)
      }
    },
    {
      itemRevId: "CAP-1210@C",
      partNumber: "CAP-1210-HV",
      revision: "C",
      title: "1210 MLCC Capacitor 630V X7R 10mOhm (Alternate Supplier)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        v_rated: qty(630, 0, "V"),
        esr: qty(10, 0, "mOhm"),
        dielectric: enumVal("X7R"),
        min_temp_rated: qty(-30, 0, "degC"),
        halogen_free: boolVal(true)
      }
    },
    {
      itemRevId: "CAP-1210@D_DRAFT",
      partNumber: "CAP-1210-HV",
      revision: "D",
      title: "1210 MLCC Capacitor 1200V C0G (Unapproved Engineering Sample)",
      itemKind: "COMPONENT",
      specStatus: "DRAFT",
      attributes: {
        v_rated: qty(1200, 0, "V"),
        esr: qty(9, 0, "mOhm"),
        dielectric: enumVal("C0G"),
        min_temp_rated: qty(-40, 0, "degC"),
        halogen_free: boolVal(true)
      }
    },
    {
      itemRevId: "DRV-ISO@A",
      partNumber: "DRV-ISO-5A",
      revision: "A",
      title: "Isolated SiC Gate Driver Rev A",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: { prop_delay_ns: qty(28, 0, "ns") }
    },
    {
      itemRevId: "DRV-ISO@B",
      partNumber: "DRV-ISO-5A",
      revision: "B",
      title: "Isolated SiC Gate Driver Rev B (Faster Slew)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: { prop_delay_ns: qty(19, 0, "ns") }
    },
    {
      itemRevId: "SEAL-EPDM@A",
      partNumber: "SEAL-EPDM-PERIM",
      revision: "A",
      title: "Perimeter Enclosure Gasket EPDM Rev A",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: { shore_hardness: qty(65, 0, "ShoreA") }
    },
    {
      itemRevId: "SEAL-EPDM@B",
      partNumber: "SEAL-EPDM-PERIM",
      revision: "B",
      title: "Perimeter Enclosure Gasket Fluoroelastomer Rev B",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: { shore_hardness: qty(65, 0, "ShoreA") }
    }
  ];

  const env400 = {
    bus_voltage: qty(400, 0, "V"),
    max_ambient: qty(55, 0, "degC"),
    min_ambient: qty(-20, 0, "degC"),
    aux_rail_voltage: qty(12, 0, "V")
  };

  const env800 = {
    bus_voltage: qty(800, 0, "V"),
    max_ambient: qty(60, 0, "degC"),
    min_ambient: qty(-20, 0, "degC"),
    aux_rail_voltage: qty(12, 0, "V")
  };

  const evidenceRecords: VerificationEvidence[] = [
    {
      evidenceId: "EV-400-RIPPLE",
      obligationId: "OBL_THERM_RIPPLE",
      jiraIssueId: "10101",
      jiraIssueKey: "VER-101",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["10101"]!),
      testedVariantId: "VAR_400V",
      testedSlotBinding: {
        "HV_INV/DC_LINK_CAP_C14": "CAP-1210@B",
        "HV_INV/GATE_DRIVER_U3": "DRV-ISO@A"
      },
      testedOperatingConditions: {
        bus_voltage: qty(400, 0, "V"),
        max_ambient: qty(55, 0, "degC"),
        min_ambient: qty(-20, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-800-RIPPLE",
      obligationId: "OBL_THERM_RIPPLE",
      jiraIssueId: "10102",
      jiraIssueKey: "VER-102",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["10102"]!),
      testedVariantId: "VAR_800V",
      testedSlotBinding: {
        "HV_INV/DC_LINK_CAP_C14": "CAP-1210@B",
        "HV_INV/GATE_DRIVER_U3": "DRV-ISO@A"
      },
      testedOperatingConditions: {
        bus_voltage: qty(800, 0, "V"),
        max_ambient: qty(60, 0, "degC"),
        min_ambient: qty(-20, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-400-AUX",
      obligationId: "OBL_AUX_EMC",
      jiraIssueId: "10103",
      jiraIssueKey: "VER-103",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["10103"]!),
      testedVariantId: "VAR_400V",
      testedSlotBinding: {
        "AUX_12V/FILTER_CAP_C1": "CAP-1210@B"
      },
      testedOperatingConditions: {
        aux_rail_voltage: qty(12, 0, "V")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-800-AUX",
      obligationId: "OBL_AUX_EMC",
      jiraIssueId: "10104",
      jiraIssueKey: "VER-104",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["10104"]!),
      testedVariantId: "VAR_800V",
      testedSlotBinding: {
        "AUX_12V/FILTER_CAP_C1": "CAP-1210@B"
      },
      testedOperatingConditions: {
        aux_rail_voltage: qty(12, 0, "V")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-400-IP67",
      obligationId: "OBL_INGRESS",
      jiraIssueId: "10105",
      jiraIssueKey: "VER-105",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["10105"]!),
      testedVariantId: "VAR_400V",
      testedSlotBinding: {
        ENCLOSURE_SEAL_S1: "SEAL-EPDM@A"
      },
      testedOperatingConditions: {
        max_ambient: qty(55, 0, "degC"),
        min_ambient: qty(-20, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-800-IP67",
      obligationId: "OBL_INGRESS",
      jiraIssueId: "10106",
      jiraIssueKey: "VER-106",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["10106"]!),
      testedVariantId: "VAR_800V",
      testedSlotBinding: {
        ENCLOSURE_SEAL_S1: "SEAL-EPDM@A"
      },
      testedOperatingConditions: {
        max_ambient: qty(60, 0, "degC"),
        min_ambient: qty(-20, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    }
  ];

  const carryForwardRules: CarryForwardRule[] = [
    {
      ruleId: "CFR-400-CAP-SUB",
      ruleVersion: 1,
      obligationId: "OBL_THERM_RIPPLE",
      sourceEvidenceId: "EV-400-RIPPLE",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-chief-power-eng",
      changeableSlots: ["HV_INV/DC_LINK_CAP_C14"],
      changeableEnvelopeKeys: ["max_ambient", "min_ambient"],
      envelopePredicate: {
        kind: "AND",
        args: [
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "variant_env", envKey: "bus_voltage" },
            right: { source: "literal", value: qty(450, 0, "V") }
          },
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "variant_env", envKey: "max_ambient" },
            right: { source: "literal", value: qty(60, 0, "degC") }
          },
          {
            kind: "CMP_NUM",
            cmp: "GTE",
            left: { source: "variant_env", envKey: "min_ambient" },
            right: { source: "literal", value: qty(-30, 0, "degC") }
          }
        ]
      },
      validityPredicate: {
        kind: "AND",
        args: [
          {
            kind: "CMP_NUM",
            cmp: "GTE",
            left: {
              source: "slot_attr",
              slotPath: "HV_INV/DC_LINK_CAP_C14",
              attrKey: "v_rated"
            },
            right: {
              op: "SCALE",
              factorMantissa: 125,
              factorScale: -2,
              arg: { source: "variant_env", envKey: "bus_voltage" }
            }
          },
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "slot_attr", slotPath: "HV_INV/DC_LINK_CAP_C14", attrKey: "esr" },
            right: { source: "literal", value: qty(15, 0, "mOhm") }
          },
          {
            kind: "CMP_ENUM",
            cmp: "IN",
            ref: {
              source: "slot_attr",
              slotPath: "HV_INV/DC_LINK_CAP_C14",
              attrKey: "dielectric"
            },
            allowed: ["C0G", "X7R"]
          },
          {
            kind: "NOT",
            arg: {
              kind: "CMP_BOOL",
              expected: false,
              ref: {
                source: "slot_attr",
                slotPath: "HV_INV/DC_LINK_CAP_C14",
                attrKey: "halogen_free"
              }
            }
          }
        ]
      },
      requiresDispositionSignoff: true
    },
    {
      ruleId: "CFR-800-CAP-SUB",
      ruleVersion: 1,
      obligationId: "OBL_THERM_RIPPLE",
      sourceEvidenceId: "EV-800-RIPPLE",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-chief-power-eng",
      changeableSlots: ["HV_INV/DC_LINK_CAP_C14"],
      changeableEnvelopeKeys: ["max_ambient", "min_ambient"],
      envelopePredicate: {
        kind: "AND",
        args: [
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "variant_env", envKey: "bus_voltage" },
            right: { source: "literal", value: qty(850, 0, "V") }
          },
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "variant_env", envKey: "max_ambient" },
            right: { source: "literal", value: qty(60, 0, "degC") }
          },
          {
            kind: "CMP_NUM",
            cmp: "GTE",
            left: { source: "variant_env", envKey: "min_ambient" },
            right: { source: "literal", value: qty(-30, 0, "degC") }
          }
        ]
      },
      validityPredicate: {
        kind: "AND",
        args: [
          {
            kind: "CMP_NUM",
            cmp: "GTE",
            left: {
              source: "slot_attr",
              slotPath: "HV_INV/DC_LINK_CAP_C14",
              attrKey: "v_rated"
            },
            right: {
              op: "SCALE",
              factorMantissa: 125,
              factorScale: -2,
              arg: { source: "variant_env", envKey: "bus_voltage" }
            }
          },
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "slot_attr", slotPath: "HV_INV/DC_LINK_CAP_C14", attrKey: "esr" },
            right: { source: "literal", value: qty(15, 0, "mOhm") }
          },
          {
            kind: "CMP_ENUM",
            cmp: "EQ",
            ref: {
              source: "slot_attr",
              slotPath: "HV_INV/DC_LINK_CAP_C14",
              attrKey: "dielectric"
            },
            allowed: ["C0G"]
          }
        ]
      },
      requiresDispositionSignoff: true
    },
    {
      ruleId: "CFR-AUX-12V-CAP-400",
      ruleVersion: 1,
      obligationId: "OBL_AUX_EMC",
      sourceEvidenceId: "EV-400-AUX",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-emc-lead",
      changeableSlots: ["AUX_12V/FILTER_CAP_C1"],
      changeableEnvelopeKeys: [],
      envelopePredicate: {
        kind: "CMP_NUM",
        cmp: "LTE",
        left: { source: "variant_env", envKey: "aux_rail_voltage" },
        right: { source: "literal", value: qty(16, 0, "V") }
      },
      validityPredicate: {
        kind: "CMP_NUM",
        cmp: "GTE",
        left: { source: "slot_attr", slotPath: "AUX_12V/FILTER_CAP_C1", attrKey: "v_rated" },
        right: { source: "literal", value: qty(50, 0, "V") }
      },
      requiresDispositionSignoff: false
    },
    {
      ruleId: "CFR-AUX-12V-CAP-800",
      ruleVersion: 1,
      obligationId: "OBL_AUX_EMC",
      sourceEvidenceId: "EV-800-AUX",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-emc-lead",
      changeableSlots: ["AUX_12V/FILTER_CAP_C1"],
      changeableEnvelopeKeys: [],
      envelopePredicate: {
        kind: "CMP_NUM",
        cmp: "LTE",
        left: { source: "variant_env", envKey: "aux_rail_voltage" },
        right: { source: "literal", value: qty(16, 0, "V") }
      },
      validityPredicate: {
        kind: "CMP_NUM",
        cmp: "GTE",
        left: { source: "slot_attr", slotPath: "AUX_12V/FILTER_CAP_C1", attrKey: "v_rated" },
        right: { source: "literal", value: qty(50, 0, "V") }
      },
      requiresDispositionSignoff: false
    }
  ];

  return {
    familyId: "FAM-HELIOS-PACK",
    rootAssemblyRevId: "PACK-HELIOS@A",
    policy: {
      policyId: "POL-HELIOS-PROD",
      policyVersion: 1,
      requiredAttestationRoles: ["Lead Engineers", "Quality Approvers"],
      carryForwardDispositionRole: "Power Electronics Disposition Authority",
      enforceSeparationOfDuties: true,
      allowRuleBasedCarryForward: true
    },
    variants: [
      {
        variantId: "VAR_400V",
        skuCode: "SKU-HEL-400",
        displayName: "Helios 400V Commuter Pack",
        operatingEnvelope: env400
      },
      {
        variantId: "VAR_800V",
        skuCode: "SKU-HEL-800",
        displayName: "Helios 800V HyperCharge Pack",
        operatingEnvelope: env800
      }
    ],
    itemRevisions,
    baselineBomEdges: [
      {
        edgeId: "E-ROOT-HVINV",
        parentItemRevId: "PACK-HELIOS@A",
        slotKey: "HV_INV",
        childItemRevId: "HV_INV@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-ROOT-AUX",
        parentItemRevId: "PACK-HELIOS@A",
        slotKey: "AUX_12V",
        childItemRevId: "AUX_12V@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-ROOT-SEAL",
        parentItemRevId: "PACK-HELIOS@A",
        slotKey: "ENCLOSURE_SEAL_S1",
        childItemRevId: "SEAL-EPDM@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-HVINV-C14",
        parentItemRevId: "HV_INV@A",
        slotKey: "DC_LINK_CAP_C14",
        childItemRevId: "CAP-1210@B",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-HVINV-U3",
        parentItemRevId: "HV_INV@A",
        slotKey: "GATE_DRIVER_U3",
        childItemRevId: "DRV-ISO@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-AUX-C1",
        parentItemRevId: "AUX_12V@A",
        slotKey: "FILTER_CAP_C1",
        childItemRevId: "CAP-1210@B",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      }
    ],
    obligations: [
      {
        obligationId: "OBL_THERM_RIPPLE",
        code: "OBL-HV-RIPPLE",
        title: "High-Voltage DC-Link Thermal Ripple & dV/dt Stress",
        applicableVariants: "ALL",
        carryForwardMode: "EXPLICIT_RULE_REQUIRED",
        governedSlotPaths: ["HV_INV/DC_LINK_CAP_C14", "HV_INV/GATE_DRIVER_U3"],
        excludedSlots: [
          {
            slotPath: "AUX_12V/FILTER_CAP_C1",
            justification: "Galvanically isolated 12V LV buck output; zero coupling to HV DC-link ripple.",
            approvedByAccountId: "acct-chief-power-eng"
          },
          {
            slotPath: "ENCLOSURE_SEAL_S1",
            justification: "Mechanical perimeter gasket; thermal resistance invariant across gasket elastomers.",
            approvedByAccountId: "acct-chief-power-eng"
          }
        ],
        governedEnvelopeKeys: ["bus_voltage", "max_ambient", "min_ambient"],
        excludedEnvelopeKeys: [
          {
            envKey: "aux_rail_voltage",
            justification: "LV auxiliary rail regulated independently downstream of isolated DC/DC.",
            approvedByAccountId: "acct-chief-power-eng"
          }
        ]
      },
      {
        obligationId: "OBL_AUX_EMC",
        code: "OBL-AUX-12V-EMC",
        title: "12V Auxiliary Rail Conducted Emissions",
        applicableVariants: "ALL",
        carryForwardMode: "EXPLICIT_RULE_REQUIRED",
        governedSlotPaths: ["AUX_12V/FILTER_CAP_C1"],
        excludedSlots: [
          {
            slotPath: "HV_INV/DC_LINK_CAP_C14",
            justification: "Isolated HV traction bus tested under separate CISPR 25 HV harness spec.",
            approvedByAccountId: "acct-emc-lead"
          },
          {
            slotPath: "HV_INV/GATE_DRIVER_U3",
            justification: "HV inverter gate drive isolated across reinforced transformer barrier.",
            approvedByAccountId: "acct-emc-lead"
          },
          {
            slotPath: "ENCLOSURE_SEAL_S1",
            justification: "Non-conductive perimeter seal outside 12V conducted filter path.",
            approvedByAccountId: "acct-emc-lead"
          }
        ],
        governedEnvelopeKeys: ["aux_rail_voltage"],
        excludedEnvelopeKeys: [
          {
            envKey: "bus_voltage",
            justification: "12V buck input isolated via pre-regulated intermediate bus.",
            approvedByAccountId: "acct-emc-lead"
          },
          {
            envKey: "max_ambient",
            justification: "Covered within component rated temperature range [-30C..85C].",
            approvedByAccountId: "acct-emc-lead"
          },
          {
            envKey: "min_ambient",
            justification: "Covered within component rated temperature range [-30C..85C].",
            approvedByAccountId: "acct-emc-lead"
          }
        ]
      },
      {
        obligationId: "OBL_INGRESS",
        code: "OBL-IP67-INGRESS",
        title: "Enclosure IP67 Immersion & Pressure Decay",
        applicableVariants: "ALL",
        carryForwardMode: "RETEST_REQUIRED",
        governedSlotPaths: ["ENCLOSURE_SEAL_S1"],
        excludedSlots: [
          {
            slotPath: "HV_INV/DC_LINK_CAP_C14",
            justification: "Internal PCB surface-mount component inside sealed housing cavity.",
            approvedByAccountId: "acct-mech-lead"
          },
          {
            slotPath: "HV_INV/GATE_DRIVER_U3",
            justification: "Internal PCB IC inside sealed housing cavity.",
            approvedByAccountId: "acct-mech-lead"
          },
          {
            slotPath: "AUX_12V/FILTER_CAP_C1",
            justification: "Internal PCB capacitor inside sealed housing cavity.",
            approvedByAccountId: "acct-mech-lead"
          }
        ],
        governedEnvelopeKeys: ["max_ambient", "min_ambient"],
        excludedEnvelopeKeys: [
          {
            envKey: "bus_voltage",
            justification: "Mechanical pressure decay test is unpowered / voltage-independent.",
            approvedByAccountId: "acct-mech-lead"
          },
          {
            envKey: "aux_rail_voltage",
            justification: "Mechanical pressure decay test is unpowered.",
            approvedByAccountId: "acct-mech-lead"
          }
        ]
      }
    ],
    evidenceRecords,
    carryForwardRules,
    retestDominanceRules: [
      {
        dominanceRuleId: "DOM-800-COVERS-400-RIPPLE",
        obligationId: "OBL_THERM_RIPPLE",
        approvalStatus: "APPROVED",
        coveringVariantId: "VAR_800V",
        coveredVariantIds: ["VAR_400V"]
      }
    ]
  };
}

export function createHeliosDefaultEco(): EcoMetadata {
  return {
    ecoJiraIssueId: "20204",
    ecoJiraKey: "ECO-204",
    ecoCreatedAtEpochMs: HELIOS_BASE_EPOCH_MS,
    authorAccountId: "acct-eco-author",
    lastEditorAccountId: "acct-eco-author",
    approvalGeneration: 1,
    liveEcoStatusCategoryKey: "indeterminate"
  };
}

export function createHeliosTrustedRoles(): Record<string, readonly string[]> {
  return {
    "Lead Engineers": ["acct-lead-eng-1", "acct-multi-role-user", "acct-eco-author"],
    "Quality Approvers": ["acct-qa-approver-1", "acct-multi-role-user"],
    "Power Electronics Disposition Authority": ["acct-pe-authority-1"]
  };
}

export function buildHeliosCapRevCSubstitution(
  catalog: FamilyCatalog,
  targetVariants: "ALL" | readonly string[] = "ALL",
  serialFrom = 5000
): ChangeOperation[] {
  return buildSerialScopedSubstitutionOps({
    currentEdges: catalog.baselineBomEdges,
    allVariantIds: catalog.variants.map((v) => v.variantId),
    parentItemRevId: "HV_INV@A",
    slotKey: "DC_LINK_CAP_C14",
    newChildItemRevId: "CAP-1210@C",
    newEdgeIdPrefix: "E-ECO204-C14",
    targetVariants,
    serialFrom,
    serialTo: null
  });
}

export function createHeliosVerificationInput(
  proposedOperations: readonly ChangeOperation[] = []
): VerificationInput {
  const liveIssues = createHeliosLiveIssues();
  const catalog = createHeliosCatalog(liveIssues);
  return {
    catalog,
    eco: createHeliosDefaultEco(),
    proposedOperations,
    liveVerificationIssuesById: liveIssues,
    attestations: [],
    trustedRoleMembersByRole: createHeliosTrustedRoles()
  };
}
