export type IndustryTemplateId =
  | "AUTOMOTIVE_EV_HELIOS"
  | "MEDTECH_INFUSION_PUMP"
  | "AEROSPACE_FLIGHT_ACTUATOR";

export interface IndustryTemplateDescriptor {
  readonly templateId: IndustryTemplateId;
  readonly domainLabel: string;
  readonly standardReference: string;
  readonly summary: string;
  readonly flagshipCutoverLabel: string;
  readonly flagshipScopedLabel: string;
  readonly flagshipScopedVariantId: string;
}

export const INDUSTRY_TEMPLATES: readonly IndustryTemplateDescriptor[] = [
  {
    templateId: "AUTOMOTIVE_EV_HELIOS",
    domainLabel: "Automotive EV Powertrain (Helios 400V/800V Traction Pack)",
    standardReference: "ISO 26262 / LV124 / CISPR 25",
    summary:
      "Dual-voltage SiC inverter traction battery pack with HV DC-link thermal ripple, 12V conducted EMC, and IP67 immersion obligations.",
    flagshipCutoverLabel: "Propose Cap Rev C (ALL, SN>=5000)",
    flagshipScopedLabel: "Scope Cap Rev C to 400V Only (SN>=5000)",
    flagshipScopedVariantId: "VAR_400V"
  },
  {
    templateId: "MEDTECH_INFUSION_PUMP",
    domainLabel: "MedTech Class III (PulseGuard ICU/NICU Infusion Pump)",
    standardReference: "IEC 60601-1 / IEC 60601-2-24 / ISO 14971",
    summary:
      "Dual-channel hospital infusion pump governing volumetric micro-bolus flow accuracy (Adult ICU vs. Neonatal NICU), 4kV patient isolation, and USP Class VI biocompatibility.",
    flagshipCutoverLabel: "Propose Flow Sensor Rev B (ALL, SN>=5000)",
    flagshipScopedLabel: "Scope Flow Sensor Rev B to Adult ICU Only (SN>=5000)",
    flagshipScopedVariantId: "VAR_ADULT_ICU"
  },
  {
    templateId: "AEROSPACE_FLIGHT_ACTUATOR",
    domainLabel: "Aerospace Flight Control (Aegis DO-160G Electro-Hydrostatic Actuator)",
    standardReference: "RTCA DO-160G / ARP4754A / DO-254",
    summary:
      "Primary flight-surface actuator governing servo-loop position resolver cold-soak (-40C Regional vs. -55C Stratospheric), 270V/28V EMI, and altitude pressure sealing.",
    flagshipCutoverLabel: "Propose Resolver Rev B (ALL, SN>=5000)",
    flagshipScopedLabel: "Scope Resolver Rev B to Regional Only (SN>=5000)",
    flagshipScopedVariantId: "VAR_REGIONAL_TURBOPROP"
  }
];
