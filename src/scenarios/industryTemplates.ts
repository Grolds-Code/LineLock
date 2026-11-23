import { computePinnedIssueStateHash } from "../core/canonical";
import { buildSerialScopedSubstitutionOps } from "../core/intervals";
import {
  boolVal,
  enumVal,
  qty,
  type CarryForwardRule,
  type ChangeOperation,
  type FamilyCatalog,
  type ItemRevision,
  type LiveJiraIssueProjection,
  type VerificationEvidence
} from "../core/types";
import {
  HELIOS_BASE_EPOCH_MS,
  createHeliosCatalog,
  createHeliosLiveIssues
} from "./heliosBatteryPack";
import {
  INDUSTRY_TEMPLATES,
  type IndustryTemplateDescriptor,
  type IndustryTemplateId
} from "./templateMetadata";

export { INDUSTRY_TEMPLATES, type IndustryTemplateDescriptor, type IndustryTemplateId };

export function createMedTechLiveIssues(): Record<string, LiveJiraIssueProjection> {
  const issues: LiveJiraIssueProjection[] = [
    {
      issueId: "20101",
      issueKey: "MED-101",
      summary: "Adult ICU Volumetric Flow Accuracy Qualification (IEC 60601-2-24)",
      description:
        "Validated PUMP_DRV/FLOW_SENSOR_S1=SENS-MEMS@A (+/-1.5% err) on Adult ICU channel (tol <= 3.0%, [5C..40C]).",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 40_000,
      structuredFields: {}
    },
    {
      issueId: "20102",
      issueKey: "MED-102",
      summary: "Neonatal NICU Micro-Bolus Trumpet Curve Qualification (IEC 60601-2-24)",
      description:
        "Validated PUMP_DRV/FLOW_SENSOR_S1=SENS-MEMS@A (+/-1.5% err) on Neonatal NICU micro-infusion (tol <= 1.8%, [10C..40C]).",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 45_000,
      structuredFields: {}
    },
    {
      issueId: "20103",
      issueKey: "MED-103",
      summary: "Adult ICU 4000Vrms Type CF Patient Isolation Dielectric Test",
      description:
        "Validated POWER_ISO/PATIENT_BARRIER_T1=XFMR-MED@A at 4000Vrms reinforced barrier on Adult ICU variant.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 20_000,
      structuredFields: {}
    },
    {
      issueId: "20104",
      issueKey: "MED-104",
      summary: "Neonatal NICU 4000Vrms Type CF Patient Leakage & Dielectric Test",
      description:
        "Validated POWER_ISO/PATIENT_BARRIER_T1=XFMR-MED@A at 4000Vrms reinforced barrier on Neonatal NICU variant.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 20_000,
      structuredFields: {}
    },
    {
      issueId: "20105",
      issueKey: "MED-105",
      summary: "USP Class VI & ISO 10993 Fluid-Path Extractables Qualification (Adult)",
      description:
        "Validated FLUID_SEAL_G1=TUBE-SIL@A USP Class VI platinum-cured elastomer on Adult ICU set.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 15_000,
      structuredFields: {}
    },
    {
      issueId: "20106",
      issueKey: "MED-106",
      summary: "USP Class VI & ISO 10993 Fluid-Path Extractables Qualification (NICU)",
      description:
        "Validated FLUID_SEAL_G1=TUBE-SIL@A USP Class VI platinum-cured elastomer on Neonatal NICU set.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 15_000,
      structuredFields: {}
    }
  ];

  const byId: Record<string, LiveJiraIssueProjection> = {};
  for (const issue of issues) {
    byId[issue.issueId] = issue;
  }
  return byId;
}

export function createMedTechCatalog(
  liveIssuesById: Readonly<Record<string, LiveJiraIssueProjection>> = createMedTechLiveIssues()
): FamilyCatalog {
  // Leaf component paths resolved from root PUMP-PULSEGUARD@A:
  // 1. PUMP_DRV/FLOW_SENSOR_S1
  // 2. POWER_ISO/PATIENT_BARRIER_T1
  // 3. FLUID_SEAL_G1
  const itemRevisions: ItemRevision[] = [
    {
      itemRevId: "PUMP-PULSEGUARD@A",
      partNumber: "PUMP-PULSEGUARD",
      revision: "A",
      title: "PulseGuard Class III Dual-Channel Infusion Pump",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "PUMP_DRV@A",
      partNumber: "PUMP-DRV-MOD",
      revision: "A",
      title: "Peristaltic Metering Drive & Flow Sensing Module",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "POWER_ISO@A",
      partNumber: "POWER-ISO-MOD",
      revision: "A",
      title: "Type CF Reinforced Medical Isolation Supply",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "SENS-MEMS@A",
      partNumber: "SENS-MEMS-FLOW",
      revision: "A",
      title: "Thermal MEMS Ultrasonic Flow Sensor Rev A (+/-1.5% mL/h)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        flow_err_mdir: qty(15, -1, "pct"),
        min_temp_rated: qty(0, 0, "degC"),
        biocompat_free_latex: boolVal(true)
      }
    },
    {
      itemRevId: "SENS-MEMS@B",
      partNumber: "SENS-MEMS-FLOW",
      revision: "B",
      title: "Thermal MEMS Flow Sensor Rev B (+/-2.4% mL/h Second Source)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        flow_err_mdir: qty(24, -1, "pct"),
        min_temp_rated: qty(0, 0, "degC"),
        biocompat_free_latex: boolVal(true)
      }
    },
    {
      itemRevId: "SENS-MEMS@C_DRAFT",
      partNumber: "SENS-MEMS-FLOW",
      revision: "C",
      title: "Next-Gen Optical Flow Sensor Prototype (Unapproved Sample)",
      itemKind: "COMPONENT",
      specStatus: "DRAFT",
      attributes: {
        flow_err_mdir: qty(10, -1, "pct"),
        min_temp_rated: qty(0, 0, "degC"),
        biocompat_free_latex: boolVal(true)
      }
    },
    {
      itemRevId: "XFMR-MED@A",
      partNumber: "XFMR-MED-CF",
      revision: "A",
      title: "Reinforced Planar Isolation Transformer 4500Vrms",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        isolation_v: qty(4500, 0, "V")
      }
    },
    {
      itemRevId: "TUBE-SIL@A",
      partNumber: "TUBE-SIL-PLAT",
      revision: "A",
      title: "Platinum-Cured Silicone Fluid Seal Rev A (USP Class VI)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        usp_class: enumVal("USP_CLASS_VI")
      }
    },
    {
      itemRevId: "TUBE-SIL@B",
      partNumber: "TUBE-SIL-PLAT",
      revision: "B",
      title: "Platinum-Cured Silicone Fluid Seal Rev B (Alternate Mold)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        usp_class: enumVal("USP_CLASS_VI")
      }
    }
  ];

  const envAdult = {
    bolus_tol_pct: qty(30, -1, "pct"),
    iso_barrier_v: qty(4000, 0, "V"),
    max_ambient: qty(40, 0, "degC"),
    min_ambient: qty(5, 0, "degC")
  };

  const envNicu = {
    bolus_tol_pct: qty(18, -1, "pct"),
    iso_barrier_v: qty(4000, 0, "V"),
    max_ambient: qty(40, 0, "degC"),
    min_ambient: qty(10, 0, "degC")
  };

  const evidenceRecords: VerificationEvidence[] = [
    {
      evidenceId: "EV-MED-ADULT-FLOW",
      obligationId: "OBL_MED_FLOW",
      jiraIssueId: "20101",
      jiraIssueKey: "MED-101",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["20101"]!),
      testedVariantId: "VAR_ADULT_ICU",
      testedSlotBinding: { "PUMP_DRV/FLOW_SENSOR_S1": "SENS-MEMS@A" },
      testedOperatingConditions: {
        bolus_tol_pct: qty(30, -1, "pct"),
        max_ambient: qty(40, 0, "degC"),
        min_ambient: qty(5, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-MED-NICU-FLOW",
      obligationId: "OBL_MED_FLOW",
      jiraIssueId: "20102",
      jiraIssueKey: "MED-102",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["20102"]!),
      testedVariantId: "VAR_NEONATAL_NICU",
      testedSlotBinding: { "PUMP_DRV/FLOW_SENSOR_S1": "SENS-MEMS@A" },
      testedOperatingConditions: {
        bolus_tol_pct: qty(18, -1, "pct"),
        max_ambient: qty(40, 0, "degC"),
        min_ambient: qty(10, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-MED-ADULT-ISO",
      obligationId: "OBL_MED_ISO",
      jiraIssueId: "20103",
      jiraIssueKey: "MED-103",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["20103"]!),
      testedVariantId: "VAR_ADULT_ICU",
      testedSlotBinding: { "POWER_ISO/PATIENT_BARRIER_T1": "XFMR-MED@A" },
      testedOperatingConditions: { iso_barrier_v: qty(4000, 0, "V") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-MED-NICU-ISO",
      obligationId: "OBL_MED_ISO",
      jiraIssueId: "20104",
      jiraIssueKey: "MED-104",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["20104"]!),
      testedVariantId: "VAR_NEONATAL_NICU",
      testedSlotBinding: { "POWER_ISO/PATIENT_BARRIER_T1": "XFMR-MED@A" },
      testedOperatingConditions: { iso_barrier_v: qty(4000, 0, "V") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-MED-ADULT-BIO",
      obligationId: "OBL_MED_BIO",
      jiraIssueId: "20105",
      jiraIssueKey: "MED-105",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["20105"]!),
      testedVariantId: "VAR_ADULT_ICU",
      testedSlotBinding: { FLUID_SEAL_G1: "TUBE-SIL@A" },
      testedOperatingConditions: { max_ambient: qty(40, 0, "degC") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-MED-NICU-BIO",
      obligationId: "OBL_MED_BIO",
      jiraIssueId: "20106",
      jiraIssueKey: "MED-106",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["20106"]!),
      testedVariantId: "VAR_NEONATAL_NICU",
      testedSlotBinding: { FLUID_SEAL_G1: "TUBE-SIL@A" },
      testedOperatingConditions: { max_ambient: qty(40, 0, "degC") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    }
  ];

  const carryForwardRules: CarryForwardRule[] = [
    {
      ruleId: "CFR-MED-FLOW-ADULT",
      ruleVersion: 1,
      obligationId: "OBL_MED_FLOW",
      sourceEvidenceId: "EV-MED-ADULT-FLOW",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-clinical-qa",
      changeableSlots: ["PUMP_DRV/FLOW_SENSOR_S1"],
      changeableEnvelopeKeys: ["max_ambient", "min_ambient"],
      envelopePredicate: {
        kind: "AND",
        args: [
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "variant_env", envKey: "max_ambient" },
            right: { source: "literal", value: qty(45, 0, "degC") }
          },
          {
            kind: "CMP_NUM",
            cmp: "GTE",
            left: { source: "variant_env", envKey: "min_ambient" },
            right: { source: "literal", value: qty(5, 0, "degC") }
          }
        ]
      },
      validityPredicate: {
        kind: "CMP_NUM",
        cmp: "LTE",
        left: {
          source: "slot_attr",
          slotPath: "PUMP_DRV/FLOW_SENSOR_S1",
          attrKey: "flow_err_mdir"
        },
        right: { source: "variant_env", envKey: "bolus_tol_pct" }
      },
      requiresDispositionSignoff: true
    },
    {
      ruleId: "CFR-MED-FLOW-NICU",
      ruleVersion: 1,
      obligationId: "OBL_MED_FLOW",
      sourceEvidenceId: "EV-MED-NICU-FLOW",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-clinical-qa",
      changeableSlots: ["PUMP_DRV/FLOW_SENSOR_S1"],
      changeableEnvelopeKeys: ["max_ambient", "min_ambient"],
      envelopePredicate: {
        kind: "AND",
        args: [
          {
            kind: "CMP_NUM",
            cmp: "LTE",
            left: { source: "variant_env", envKey: "max_ambient" },
            right: { source: "literal", value: qty(42, 0, "degC") }
          },
          {
            kind: "CMP_NUM",
            cmp: "GTE",
            left: { source: "variant_env", envKey: "min_ambient" },
            right: { source: "literal", value: qty(10, 0, "degC") }
          }
        ]
      },
      validityPredicate: {
        kind: "CMP_NUM",
        cmp: "LTE",
        left: {
          source: "slot_attr",
          slotPath: "PUMP_DRV/FLOW_SENSOR_S1",
          attrKey: "flow_err_mdir"
        },
        right: { source: "variant_env", envKey: "bolus_tol_pct" }
      },
      requiresDispositionSignoff: true
    }
  ];

  return {
    familyId: "PULSEGUARD-INFUSION-2026",
    rootAssemblyRevId: "PUMP-PULSEGUARD@A",
    policy: {
      policyId: "POL-MEDTECH-60601",
      policyVersion: 1,
      requiredAttestationRoles: ["Lead Engineers", "Quality Approvers"],
      carryForwardDispositionRole: "Power Electronics Disposition Authority",
      enforceSeparationOfDuties: true,
      allowRuleBasedCarryForward: true
    },
    variants: [
      {
        variantId: "VAR_ADULT_ICU",
        skuCode: "PG-ADULT-ICU",
        displayName: "PulseGuard Adult ICU Channel (<= 3.0% Flow Error)",
        operatingEnvelope: envAdult
      },
      {
        variantId: "VAR_NEONATAL_NICU",
        skuCode: "PG-NEO-NICU",
        displayName: "PulseGuard Neonatal NICU Micro-Bolus (<= 1.8% Flow Error)",
        operatingEnvelope: envNicu
      }
    ],
    itemRevisions,
    baselineBomEdges: [
      {
        edgeId: "E-MED-DRV",
        parentItemRevId: "PUMP-PULSEGUARD@A",
        slotKey: "PUMP_DRV",
        childItemRevId: "PUMP_DRV@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-MED-ISO",
        parentItemRevId: "PUMP-PULSEGUARD@A",
        slotKey: "POWER_ISO",
        childItemRevId: "POWER_ISO@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-MED-SEAL",
        parentItemRevId: "PUMP-PULSEGUARD@A",
        slotKey: "FLUID_SEAL_G1",
        childItemRevId: "TUBE-SIL@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-MED-SENS",
        parentItemRevId: "PUMP_DRV@A",
        slotKey: "FLOW_SENSOR_S1",
        childItemRevId: "SENS-MEMS@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-MED-XFMR",
        parentItemRevId: "POWER_ISO@A",
        slotKey: "PATIENT_BARRIER_T1",
        childItemRevId: "XFMR-MED@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      }
    ],
    obligations: [
      {
        obligationId: "OBL_MED_FLOW",
        code: "OBL-60601-FLOW",
        title: "Volumetric Micro-Bolus Trumpet Flow Accuracy (IEC 60601-2-24)",
        applicableVariants: "ALL",
        carryForwardMode: "EXPLICIT_RULE_REQUIRED",
        governedSlotPaths: ["PUMP_DRV/FLOW_SENSOR_S1"],
        excludedSlots: [
          {
            slotPath: "POWER_ISO/PATIENT_BARRIER_T1",
            justification: "Galvanically regulated downstream of 3.3V sensor LDO.",
            approvedByAccountId: "acct-med-systems"
          },
          {
            slotPath: "FLUID_SEAL_G1",
            justification: "Static cassette perimeter seal outside ultrasonic sensor bore.",
            approvedByAccountId: "acct-med-systems"
          }
        ],
        governedEnvelopeKeys: ["bolus_tol_pct", "max_ambient", "min_ambient"],
        excludedEnvelopeKeys: [
          {
            envKey: "iso_barrier_v",
            justification: "Mains dielectric rating orthogonal to low-voltage MEMS flow calibration.",
            approvedByAccountId: "acct-med-systems"
          }
        ]
      },
      {
        obligationId: "OBL_MED_ISO",
        code: "OBL-60601-4KV-ISO",
        title: "Type CF 4000Vrms Patient Isolation & Leakage Current",
        applicableVariants: "ALL",
        carryForwardMode: "EXPLICIT_RULE_REQUIRED",
        governedSlotPaths: ["POWER_ISO/PATIENT_BARRIER_T1"],
        excludedSlots: [
          {
            slotPath: "PUMP_DRV/FLOW_SENSOR_S1",
            justification: "Located entirely on secondary floating patient-applied side.",
            approvedByAccountId: "acct-med-safety"
          },
          {
            slotPath: "FLUID_SEAL_G1",
            justification: "Non-conductive silicone cassette gasket.",
            approvedByAccountId: "acct-med-safety"
          }
        ],
        governedEnvelopeKeys: ["iso_barrier_v"],
        excludedEnvelopeKeys: [
          {
            envKey: "bolus_tol_pct",
            justification: "Flow dosing tolerance has zero electrical coupling to isolation barrier.",
            approvedByAccountId: "acct-med-safety"
          },
          {
            envKey: "max_ambient",
            justification: "Planar transformer Class F insulation qualified to 155C.",
            approvedByAccountId: "acct-med-safety"
          },
          {
            envKey: "min_ambient",
            justification: "Dielectric breakdown voltage increases or stays constant above 0C.",
            approvedByAccountId: "acct-med-safety"
          }
        ]
      },
      {
        obligationId: "OBL_MED_BIO",
        code: "OBL-ISO10993-BIOCOMPAT",
        title: "USP Class VI & ISO 10993 Fluid-Path Biocompatibility",
        applicableVariants: "ALL",
        carryForwardMode: "RETEST_REQUIRED",
        governedSlotPaths: ["FLUID_SEAL_G1"],
        excludedSlots: [
          {
            slotPath: "PUMP_DRV/FLOW_SENSOR_S1",
            justification: "Non-contact clamp-on ultrasonic sensor outside sterile fluid path.",
            approvedByAccountId: "acct-biocompat-lead"
          },
          {
            slotPath: "POWER_ISO/PATIENT_BARRIER_T1",
            justification: "Sealed power PCB enclosure with zero fluid contact.",
            approvedByAccountId: "acct-biocompat-lead"
          }
        ],
        governedEnvelopeKeys: ["max_ambient"],
        excludedEnvelopeKeys: [
          {
            envKey: "bolus_tol_pct",
            justification: "Mechanical dosing spec unrelated to extractables/leachables.",
            approvedByAccountId: "acct-biocompat-lead"
          },
          {
            envKey: "iso_barrier_v",
            justification: "Electrical dielectric spec unrelated to polymer extractables.",
            approvedByAccountId: "acct-biocompat-lead"
          },
          {
            envKey: "min_ambient",
            justification: "Leachables extraction kinetics governed by upper temperature bound.",
            approvedByAccountId: "acct-biocompat-lead"
          }
        ]
      }
    ],
    evidenceRecords,
    carryForwardRules
  };
}

export function createAerospaceLiveIssues(): Record<string, LiveJiraIssueProjection> {
  const issues: LiveJiraIssueProjection[] = [
    {
      issueId: "30101",
      issueKey: "AERO-101",
      summary: "DO-160G Sec 4 Regional Turboprop Cold-Soak Resolver Loop Test (-40C)",
      description:
        "Validated SERVO_LOOP/RESOLVER_R1=RSLV-AERO@A (-55C rated) on Regional Turboprop [-40C..70C].",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 50_000,
      structuredFields: {}
    },
    {
      issueId: "30102",
      issueKey: "AERO-102",
      summary: "DO-160G Sec 4 Stratospheric Long-Range Cold-Soak Resolver Test (-55C)",
      description:
        "Validated SERVO_LOOP/RESOLVER_R1=RSLV-AERO@A (-55C rated) on Stratospheric Jet [-55C..70C].",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 55_000,
      structuredFields: {}
    },
    {
      issueId: "30103",
      issueKey: "AERO-103",
      summary: "DO-160G Sec 21 Conducted & Radiated RF Emissions (28V Regional)",
      description: "Validated HV_STAGE/SIC_BRIDGE_Q1=MOS-AERO@A on 28V DC Regional bus.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 25_000,
      structuredFields: {}
    },
    {
      issueId: "30104",
      issueKey: "AERO-104",
      summary: "DO-160G Sec 21 Conducted & Radiated RF Emissions (270V Stratospheric)",
      description: "Validated HV_STAGE/SIC_BRIDGE_Q1=MOS-AERO@A on 270V DC Stratospheric bus.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 25_000,
      structuredFields: {}
    },
    {
      issueId: "30105",
      issueKey: "AERO-105",
      summary: "DO-160G Sec 4.6 Rapid Decompression & Altitude Seal Test (Regional)",
      description: "Validated ALTITUDE_VENT_V1=VENT-PTFE@A on Regional Turboprop actuator.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 18_000,
      structuredFields: {}
    },
    {
      issueId: "30106",
      issueKey: "AERO-106",
      summary: "DO-160G Sec 4.6 51,000ft Rapid Decompression Seal Test (Stratospheric)",
      description: "Validated ALTITUDE_VENT_V1=VENT-PTFE@A on Stratospheric Jet actuator.",
      statusCategoryKey: "done",
      resolutionName: "Done",
      updatedAtEpochMs: HELIOS_BASE_EPOCH_MS + 18_000,
      structuredFields: {}
    }
  ];

  const byId: Record<string, LiveJiraIssueProjection> = {};
  for (const issue of issues) {
    byId[issue.issueId] = issue;
  }
  return byId;
}

export function createAerospaceCatalog(
  liveIssuesById: Readonly<Record<string, LiveJiraIssueProjection>> = createAerospaceLiveIssues()
): FamilyCatalog {
  // Leaf component paths resolved from EHA-AEGIS@A:
  // 1. SERVO_LOOP/RESOLVER_R1
  // 2. HV_STAGE/SIC_BRIDGE_Q1
  // 3. ALTITUDE_VENT_V1
  const itemRevisions: ItemRevision[] = [
    {
      itemRevId: "EHA-AEGIS@A",
      partNumber: "EHA-AEGIS",
      revision: "A",
      title: "Aegis Primary Flight-Control Electro-Hydrostatic Actuator",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "SERVO_LOOP@A",
      partNumber: "SERVO-LOOP-MOD",
      revision: "A",
      title: "Redundant Dual-Winding Position Sensing Sub-Assembly",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "HV_STAGE@A",
      partNumber: "HV-STAGE-MOD",
      revision: "A",
      title: "Fault-Tolerant Motor Drive Power Stage",
      itemKind: "ASSEMBLY",
      specStatus: "APPROVED",
      attributes: {}
    },
    {
      itemRevId: "RSLV-AERO@A",
      partNumber: "RSLV-HAR-21",
      revision: "A",
      title: "Frameless Brushless Resolver Rev A (-55C Stratospheric Rated)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        min_temp_rated: qty(-55, 0, "degC"),
        max_temp_rated: qty(125, 0, "degC"),
        qual_grade: enumVal("DO160G_CAT_A2")
      }
    },
    {
      itemRevId: "RSLV-AERO@B",
      partNumber: "RSLV-HAR-21",
      revision: "B",
      title: "Frameless Brushless Resolver Rev B (-45C Commercial Alternate)",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        min_temp_rated: qty(-45, 0, "degC"),
        max_temp_rated: qty(125, 0, "degC"),
        qual_grade: enumVal("DO160G_CAT_A2")
      }
    },
    {
      itemRevId: "MOS-AERO@A",
      partNumber: "MOS-SIC-650",
      revision: "A",
      title: "Hermetic SiC Power Bridge 650V Rev A",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        v_rated: qty(650, 0, "V")
      }
    },
    {
      itemRevId: "VENT-PTFE@A",
      partNumber: "VENT-PTFE-51K",
      revision: "A",
      title: "Sintered ePTFE Pressure-Equalization Breather Rev A",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        burst_kpa: qty(350, 0, "kPa")
      }
    },
    {
      itemRevId: "VENT-PTFE@B",
      partNumber: "VENT-PTFE-51K",
      revision: "B",
      title: "Sintered ePTFE Pressure-Equalization Breather Rev B",
      itemKind: "COMPONENT",
      specStatus: "APPROVED",
      attributes: {
        burst_kpa: qty(360, 0, "kPa")
      }
    }
  ];

  const envRegional = {
    bus_voltage: qty(28, 0, "V"),
    min_ambient: qty(-40, 0, "degC"),
    max_ambient: qty(70, 0, "degC")
  };

  const envStrat = {
    bus_voltage: qty(270, 0, "V"),
    min_ambient: qty(-55, 0, "degC"),
    max_ambient: qty(70, 0, "degC")
  };

  const evidenceRecords: VerificationEvidence[] = [
    {
      evidenceId: "EV-AERO-REG-LOOP",
      obligationId: "OBL_AERO_COLD_LOOP",
      jiraIssueId: "30101",
      jiraIssueKey: "AERO-101",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["30101"]!),
      testedVariantId: "VAR_REGIONAL_TURBOPROP",
      testedSlotBinding: { "SERVO_LOOP/RESOLVER_R1": "RSLV-AERO@A" },
      testedOperatingConditions: {
        min_ambient: qty(-40, 0, "degC"),
        max_ambient: qty(70, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-AERO-STRAT-LOOP",
      obligationId: "OBL_AERO_COLD_LOOP",
      jiraIssueId: "30102",
      jiraIssueKey: "AERO-102",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["30102"]!),
      testedVariantId: "VAR_STRATOSPHERIC_JET",
      testedSlotBinding: { "SERVO_LOOP/RESOLVER_R1": "RSLV-AERO@A" },
      testedOperatingConditions: {
        min_ambient: qty(-55, 0, "degC"),
        max_ambient: qty(70, 0, "degC")
      },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-AERO-REG-EMI",
      obligationId: "OBL_AERO_EMI",
      jiraIssueId: "30103",
      jiraIssueKey: "AERO-103",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["30103"]!),
      testedVariantId: "VAR_REGIONAL_TURBOPROP",
      testedSlotBinding: { "HV_STAGE/SIC_BRIDGE_Q1": "MOS-AERO@A" },
      testedOperatingConditions: { bus_voltage: qty(28, 0, "V") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-AERO-STRAT-EMI",
      obligationId: "OBL_AERO_EMI",
      jiraIssueId: "30104",
      jiraIssueKey: "AERO-104",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["30104"]!),
      testedVariantId: "VAR_STRATOSPHERIC_JET",
      testedSlotBinding: { "HV_STAGE/SIC_BRIDGE_Q1": "MOS-AERO@A" },
      testedOperatingConditions: { bus_voltage: qty(270, 0, "V") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-AERO-REG-SEAL",
      obligationId: "OBL_AERO_DECOMP",
      jiraIssueId: "30105",
      jiraIssueKey: "AERO-105",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["30105"]!),
      testedVariantId: "VAR_REGIONAL_TURBOPROP",
      testedSlotBinding: { ALTITUDE_VENT_V1: "VENT-PTFE@A" },
      testedOperatingConditions: { min_ambient: qty(-40, 0, "degC") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    },
    {
      evidenceId: "EV-AERO-STRAT-SEAL",
      obligationId: "OBL_AERO_DECOMP",
      jiraIssueId: "30106",
      jiraIssueKey: "AERO-106",
      pinnedIssueStateHash: computePinnedIssueStateHash(liveIssuesById["30106"]!),
      testedVariantId: "VAR_STRATOSPHERIC_JET",
      testedSlotBinding: { ALTITUDE_VENT_V1: "VENT-PTFE@A" },
      testedOperatingConditions: { min_ambient: qty(-55, 0, "degC") },
      recordedOutcome: "PASS",
      approvalStatus: "APPROVED"
    }
  ];

  const carryForwardRules: CarryForwardRule[] = [
    {
      ruleId: "CFR-AERO-RSLV-REG",
      ruleVersion: 1,
      obligationId: "OBL_AERO_COLD_LOOP",
      sourceEvidenceId: "EV-AERO-REG-LOOP",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-der-avionics",
      changeableSlots: ["SERVO_LOOP/RESOLVER_R1"],
      changeableEnvelopeKeys: ["min_ambient", "max_ambient"],
      envelopePredicate: {
        kind: "CMP_NUM",
        cmp: "GTE",
        left: { source: "variant_env", envKey: "min_ambient" },
        right: { source: "literal", value: qty(-45, 0, "degC") }
      },
      validityPredicate: {
        kind: "CMP_NUM",
        cmp: "LTE",
        left: {
          source: "slot_attr",
          slotPath: "SERVO_LOOP/RESOLVER_R1",
          attrKey: "min_temp_rated"
        },
        right: { source: "variant_env", envKey: "min_ambient" }
      },
      requiresDispositionSignoff: true
    },
    {
      ruleId: "CFR-AERO-RSLV-STRAT",
      ruleVersion: 1,
      obligationId: "OBL_AERO_COLD_LOOP",
      sourceEvidenceId: "EV-AERO-STRAT-LOOP",
      approvalStatus: "APPROVED",
      approvedByAccountId: "acct-der-avionics",
      changeableSlots: ["SERVO_LOOP/RESOLVER_R1"],
      changeableEnvelopeKeys: ["min_ambient", "max_ambient"],
      envelopePredicate: {
        kind: "CMP_NUM",
        cmp: "GTE",
        left: { source: "variant_env", envKey: "min_ambient" },
        right: { source: "literal", value: qty(-55, 0, "degC") }
      },
      validityPredicate: {
        kind: "CMP_NUM",
        cmp: "LTE",
        left: {
          source: "slot_attr",
          slotPath: "SERVO_LOOP/RESOLVER_R1",
          attrKey: "min_temp_rated"
        },
        right: { source: "variant_env", envKey: "min_ambient" }
      },
      requiresDispositionSignoff: true
    }
  ];

  return {
    familyId: "AEGIS-FLIGHT-EHA-2026",
    rootAssemblyRevId: "EHA-AEGIS@A",
    policy: {
      policyId: "POL-AERO-DO160G",
      policyVersion: 1,
      requiredAttestationRoles: ["Lead Engineers", "Quality Approvers"],
      carryForwardDispositionRole: "Power Electronics Disposition Authority",
      enforceSeparationOfDuties: true,
      allowRuleBasedCarryForward: true
    },
    variants: [
      {
        variantId: "VAR_REGIONAL_TURBOPROP",
        skuCode: "AEGIS-REG-28V",
        displayName: "Aegis Regional Turboprop EHA (28V, -40C Cold-Soak)",
        operatingEnvelope: envRegional
      },
      {
        variantId: "VAR_STRATOSPHERIC_JET",
        skuCode: "AEGIS-STRAT-270V",
        displayName: "Aegis Stratospheric Long-Range EHA (270V, -55C Cold-Soak)",
        operatingEnvelope: envStrat
      }
    ],
    itemRevisions,
    baselineBomEdges: [
      {
        edgeId: "E-AERO-LOOP",
        parentItemRevId: "EHA-AEGIS@A",
        slotKey: "SERVO_LOOP",
        childItemRevId: "SERVO_LOOP@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-AERO-HV",
        parentItemRevId: "EHA-AEGIS@A",
        slotKey: "HV_STAGE",
        childItemRevId: "HV_STAGE@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-AERO-VENT",
        parentItemRevId: "EHA-AEGIS@A",
        slotKey: "ALTITUDE_VENT_V1",
        childItemRevId: "VENT-PTFE@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-AERO-RSLV",
        parentItemRevId: "SERVO_LOOP@A",
        slotKey: "RESOLVER_R1",
        childItemRevId: "RSLV-AERO@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      },
      {
        edgeId: "E-AERO-MOS",
        parentItemRevId: "HV_STAGE@A",
        slotKey: "SIC_BRIDGE_Q1",
        childItemRevId: "MOS-AERO@A",
        variantScope: "ALL",
        serialFrom: 1000,
        serialTo: null
      }
    ],
    obligations: [
      {
        obligationId: "OBL_AERO_COLD_LOOP",
        code: "OBL-DO160-COLD-LOOP",
        title: "DO-160G Sec 4 Low-Temperature Resolver Position Accuracy",
        applicableVariants: "ALL",
        carryForwardMode: "EXPLICIT_RULE_REQUIRED",
        governedSlotPaths: ["SERVO_LOOP/RESOLVER_R1"],
        excludedSlots: [
          {
            slotPath: "HV_STAGE/SIC_BRIDGE_Q1",
            justification: "PWM drive stage decoupled from excitation resolver demodulator.",
            approvedByAccountId: "acct-der-avionics"
          },
          {
            slotPath: "ALTITUDE_VENT_V1",
            justification: "Passive housing membrane does not alter magnetic resolver airgap.",
            approvedByAccountId: "acct-der-avionics"
          }
        ],
        governedEnvelopeKeys: ["min_ambient", "max_ambient"],
        excludedEnvelopeKeys: [
          {
            envKey: "bus_voltage",
            justification: "Resolver excited by isolated 7Vrms 5kHz reference oscillator.",
            approvedByAccountId: "acct-der-avionics"
          }
        ]
      },
      {
        obligationId: "OBL_AERO_EMI",
        code: "OBL-DO160-RF-EMI",
        title: "DO-160G Sec 21 Conducted & Radiated RF Emissions",
        applicableVariants: "ALL",
        carryForwardMode: "EXPLICIT_RULE_REQUIRED",
        governedSlotPaths: ["HV_STAGE/SIC_BRIDGE_Q1"],
        excludedSlots: [
          {
            slotPath: "SERVO_LOOP/RESOLVER_R1",
            justification: "Shielded low-level twisted-pair excitation inside Faraday cavity.",
            approvedByAccountId: "acct-emi-der"
          },
          {
            slotPath: "ALTITUDE_VENT_V1",
            justification: "Non-metallic breather behind waveguide-below-cutoff boss.",
            approvedByAccountId: "acct-emi-der"
          }
        ],
        governedEnvelopeKeys: ["bus_voltage"],
        excludedEnvelopeKeys: [
          {
            envKey: "min_ambient",
            justification: "CISPR/DO-160G Sec 21 spectral mask measured at worst-case di/dt.",
            approvedByAccountId: "acct-emi-der"
          },
          {
            envKey: "max_ambient",
            justification: "EMI filter resonance verified invariant up to 85C.",
            approvedByAccountId: "acct-emi-der"
          }
        ]
      },
      {
        obligationId: "OBL_AERO_DECOMP",
        code: "OBL-DO160-DECOMP",
        title: "DO-160G Sec 4.6 Rapid Decompression & Altitude Sealing",
        applicableVariants: "ALL",
        carryForwardMode: "RETEST_REQUIRED",
        governedSlotPaths: ["ALTITUDE_VENT_V1"],
        excludedSlots: [
          {
            slotPath: "SERVO_LOOP/RESOLVER_R1",
            justification: "Internal stator assembly inside sealed hydraulic manifold.",
            approvedByAccountId: "acct-mech-der"
          },
          {
            slotPath: "HV_STAGE/SIC_BRIDGE_Q1",
            justification: "Internal power module mounted to coldplate.",
            approvedByAccountId: "acct-mech-der"
          }
        ],
        governedEnvelopeKeys: ["min_ambient"],
        excludedEnvelopeKeys: [
          {
            envKey: "bus_voltage",
            justification: "Pneumatic pressure differential independent of electrical bus.",
            approvedByAccountId: "acct-mech-der"
          },
          {
            envKey: "max_ambient",
            justification: "ePTFE seal contraction worst-case occurs at minimum stratospheric temp.",
            approvedByAccountId: "acct-mech-der"
          }
        ]
      }
    ],
    evidenceRecords,
    carryForwardRules
  };
}

export function instantiateIndustryTemplate(templateId: IndustryTemplateId): {
  readonly descriptor: IndustryTemplateDescriptor;
  readonly referenceIssues: Record<string, LiveJiraIssueProjection>;
  readonly catalog: FamilyCatalog;
} {
  const descriptor =
    INDUSTRY_TEMPLATES.find((t) => t.templateId === templateId) ?? INDUSTRY_TEMPLATES[0]!;

  if (templateId === "MEDTECH_INFUSION_PUMP") {
    const referenceIssues = createMedTechLiveIssues();
    return {
      descriptor,
      referenceIssues,
      catalog: createMedTechCatalog(referenceIssues)
    };
  }

  if (templateId === "AEROSPACE_FLIGHT_ACTUATOR") {
    const referenceIssues = createAerospaceLiveIssues();
    return {
      descriptor,
      referenceIssues,
      catalog: createAerospaceCatalog(referenceIssues)
    };
  }

  const referenceIssues = createHeliosLiveIssues();
  return {
    descriptor,
    referenceIssues,
    catalog: createHeliosCatalog(referenceIssues)
  };
}

export function buildFlagshipSubstitutionForCatalog(params: {
  readonly catalog: FamilyCatalog;
  readonly targetVariants: "ALL" | readonly string[];
  readonly serialFrom: number;
  readonly serialTo?: number | null;
}): ChangeOperation[] {
  const { catalog, targetVariants, serialFrom, serialTo = null } = params;
  const allVariantIds = catalog.variants.map((v) => v.variantId);

  if (catalog.familyId.startsWith("PULSEGUARD")) {
    return buildSerialScopedSubstitutionOps({
      currentEdges: catalog.baselineBomEdges,
      allVariantIds,
      parentItemRevId: "PUMP_DRV@A",
      slotKey: "FLOW_SENSOR_S1",
      newChildItemRevId: "SENS-MEMS@B",
      newEdgeIdPrefix: "E-MED-SUB-SENSB",
      targetVariants,
      serialFrom,
      serialTo
    });
  }

  if (catalog.familyId.startsWith("AEGIS")) {
    return buildSerialScopedSubstitutionOps({
      currentEdges: catalog.baselineBomEdges,
      allVariantIds,
      parentItemRevId: "SERVO_LOOP@A",
      slotKey: "RESOLVER_R1",
      newChildItemRevId: "RSLV-AERO@B",
      newEdgeIdPrefix: "E-AERO-SUB-RSLVB",
      targetVariants,
      serialFrom,
      serialTo
    });
  }

  return buildSerialScopedSubstitutionOps({
    currentEdges: catalog.baselineBomEdges,
    allVariantIds,
    parentItemRevId: "HV_INV@A",
    slotKey: "DC_LINK_CAP_C14",
    newChildItemRevId: "CAP-1210@C",
    newEdgeIdPrefix: "E-EV-SUB-CAPC",
    targetVariants,
    serialFrom,
    serialTo
  });
}

export function inferScopedSafeVariantForCatalog(catalog: FamilyCatalog): string {
  if (catalog.familyId.startsWith("PULSEGUARD")) return "VAR_ADULT_ICU";
  if (catalog.familyId.startsWith("AEGIS")) return "VAR_REGIONAL_TURBOPROP";
  return catalog.variants[0]?.variantId ?? "VAR_400V";
}
