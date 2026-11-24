import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  BarChart,
  Box,
  Button,
  ButtonGroup,
  Code,
  CodeBlock,
  DynamicTable,
  Heading,
  Inline,
  LoadingButton,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Select,
  Stack,
  StackBarChart,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tag,
  Text,
  TextArea,
  Textfield,
  xcss
} from "@forge/react";
import { invoke } from "@forge/bridge";
import type {
  EcoGateState,
  FamilyCatalog,
  ItemRevision,
  PredicateTraceNode,
  SerialInterval,
  SliceObligationEvaluation,
  SliceObligationStatus,
  TruthValue
} from "../core/types";
import type {
  BindJiraEvidenceRequest,
  ConnectivityProbeResult,
  CounterfactualRequest,
  CounterfactualSimulationResult,
  CustomComponentSubstitutionRequest,
  EcoWorkspaceView,
  GovernancePolicyMode,
  ScenarioPresetId
} from "../forge/ports";
import {
  INDUSTRY_TEMPLATES,
  type IndustryTemplateDescriptor,
  type IndustryTemplateId
} from "../scenarios/templateMetadata";

/** Preserve legitimate zero inputs and reject partial integer parses. */
function safeIntegerOrDefault(raw: string, fallback: number): number {
  const normalized = raw.trim();
  if (!normalized) return fallback;
  const value = Number(normalized);
  return Number.isSafeInteger(value) ? value : fallback;
}

function unwrapInvoke<T>(raw: T | { readonly body: T }): T {
  if (raw && typeof raw === "object" && "body" in raw) {
    return (raw as { readonly body: T }).body;
  }
  return raw;
}

function formatSerialRange(interval: SerialInterval): string {
  const end = interval.serialTo === null ? "+inf" : String(interval.serialTo);
  return `[SN ${interval.serialFrom}..${end})`;
}

function gateAppearance(
  state: EcoGateState
): "success" | "removed" | "moved" | "inprogress" | "default" {
  switch (state) {
    case "READY_FOR_RELEASE_TRANSITION":
    case "RELEASE_TRANSITIONED_VERIFIED":
      return "success";
    case "BLOCKED_INVALIDATED":
    case "UNVALIDATED_RELEASE_DRIFT":
      return "removed";
    case "BLOCKED_INDETERMINATE":
    case "BLOCKED_STRUCTURAL":
      return "moved";
    case "AWAITING_ATTESTATION":
    case "EVIDENCE_INCOMPLETE":
      return "inprogress";
  }
}

function gateShortLabel(state: EcoGateState): string {
  switch (state) {
    case "READY_FOR_RELEASE_TRANSITION":
      return "RELEASE READY";
    case "RELEASE_TRANSITIONED_VERIFIED":
      return "RELEASE VERIFIED";
    case "AWAITING_ATTESTATION":
      return "AWAITING SIGNOFF";
    case "EVIDENCE_INCOMPLETE":
      return "EVIDENCE MISSING";
    case "BLOCKED_INVALIDATED":
      return "BLOCKED: INVALIDATED";
    case "BLOCKED_INDETERMINATE":
      return "BLOCKED: UNKNOWN";
    case "BLOCKED_STRUCTURAL":
      return "BLOCKED: STRUCTURAL";
    case "UNVALIDATED_RELEASE_DRIFT":
      return "RELEASE DRIFT ALERT";
  }
}

function sliceStatusAppearance(
  status: SliceObligationStatus
): "success" | "inprogress" | "removed" | "moved" | "default" {
  switch (status) {
    case "SUPPORTED_AS_TESTED":
      return "success";
    case "SUPPORTED_BY_APPROVED_RULE":
      return "inprogress";
    case "INVALIDATED_EVIDENCE_DRIFT":
    case "INVALIDATED_PREDICATE_FALSE":
    case "INVALIDATED_ENVELOPE_EXCEEDED":
    case "INVALIDATED_UNCOVERED_CHANGE":
    case "INVALIDATED_RETEST_REQUIRED":
      return "removed";
    case "INDETERMINATE_MISSING_DATA":
    case "INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT":
    case "INDETERMINATE_UNEXAMINED_DEPENDENCY":
    case "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION":
    case "UNCOVERED_OR_UNEXECUTED":
      return "moved";
  }
}

function sliceShortLabel(status: SliceObligationStatus): string {
  switch (status) {
    case "SUPPORTED_AS_TESTED":
      return "AS TESTED";
    case "SUPPORTED_BY_APPROVED_RULE":
      return "APPROVED RULE";
    case "INVALIDATED_EVIDENCE_DRIFT":
      return "EVIDENCE DRIFT";
    case "INVALIDATED_PREDICATE_FALSE":
      return "PREDICATE FALSE";
    case "INVALIDATED_ENVELOPE_EXCEEDED":
      return "ENVELOPE EXCEEDED";
    case "INVALIDATED_UNCOVERED_CHANGE":
      return "UNCOVERED CHANGE";
    case "INVALIDATED_RETEST_REQUIRED":
      return "RETEST REQUIRED";
    case "INDETERMINATE_MISSING_DATA":
      return "MISSING DATA";
    case "INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT":
      return "PARTIAL FOOTPRINT";
    case "INDETERMINATE_UNEXAMINED_DEPENDENCY":
      return "UNEXAMINED SLOT";
    case "INDETERMINATE_UNEXAMINED_OPERATING_CONDITION":
      return "UNEXAMINED ENV";
    case "UNCOVERED_OR_UNEXECUTED":
      return "UNEXECUTED";
  }
}

function truthAppearance(val: TruthValue): "success" | "removed" | "moved" {
  if (val === "TRUE") return "success";
  if (val === "FALSE") return "removed";
  return "moved";
}

function extractEventString(ev: unknown): string {
  if (typeof ev === "string") return ev;
  if (ev && typeof ev === "object" && "target" in ev) {
    const val = (ev as { target?: { value?: unknown } }).target?.value;
    if (typeof val === "string") return val;
    if (typeof val === "number") return String(val);
  }
  return "";
}

function inferTemplateFromCatalog(catalog: FamilyCatalog | undefined): IndustryTemplateDescriptor {
  if (catalog?.familyId.startsWith("PULSEGUARD")) {
    return INDUSTRY_TEMPLATES[1]!;
  }
  if (catalog?.familyId.startsWith("AEGIS")) {
    return INDUSTRY_TEMPLATES[2]!;
  }
  return INDUSTRY_TEMPLATES[0]!;
}

function collectGovernedLeafSlots(catalog: FamilyCatalog | undefined): string[] {
  if (!catalog) return ["HV_INV/DC_LINK_CAP_C14"];
  const set = new Set<string>();
  for (const obl of catalog.obligations) {
    for (const sp of obl.governedSlotPaths) {
      set.add(sp);
    }
  }
  return [...set];
}

function defaultStudioFieldsForCatalog(catalog: FamilyCatalog | undefined): {
  readonly slotPath: string;
  readonly partNumber: string;
  readonly revision: string;
  readonly title: string;
  readonly attrKey: string;
  readonly attrVal: string;
  readonly attrScale: string;
  readonly attrUnit: string;
  readonly enumKey: string;
  readonly enumVal: string;
} {
  if (catalog?.familyId.startsWith("PULSEGUARD")) {
    return {
      slotPath: "PUMP_DRV/FLOW_SENSOR_S1",
      partNumber: "SENS-MEMS-FLOW",
      revision: "D",
      title: "Laser-Trimmed NICU Micro-Bolus Sensor (+/-1.2% mL/h)",
      attrKey: "flow_err_mdir",
      attrVal: "12",
      attrScale: "-1",
      attrUnit: "pct",
      enumKey: "",
      enumVal: ""
    };
  }
  if (catalog?.familyId.startsWith("AEGIS")) {
    return {
      slotPath: "SERVO_LOOP/RESOLVER_R1",
      partNumber: "RSLV-HAR-21",
      revision: "C",
      title: "Cryo-Wound Brushless Position Resolver (-60C Stratospheric)",
      attrKey: "min_temp_rated",
      attrVal: "-60",
      attrScale: "0",
      attrUnit: "degC",
      enumKey: "qual_grade",
      enumVal: "DO160G_CAT_A2"
    };
  }
  return {
    slotPath: "HV_INV/DC_LINK_CAP_C14",
    partNumber: "CAP-1210-HV",
    revision: "E",
    title: "1210 MLCC Capacitor 1100V C0G (400V & 800V Qualified)",
    attrKey: "v_rated",
    attrVal: "1100",
    attrScale: "0",
    attrUnit: "V",
    enumKey: "dielectric",
    enumVal: "C0G"
  };
}

const cardBoxStyle = xcss({
  backgroundColor: "color.background.neutral.subtle",
  borderColor: "color.border",
  borderWidth: "border.width",
  borderStyle: "solid",
  borderRadius: "radius.medium",
  padding: "space.200"
});

const metricCardStyle = xcss({
  backgroundColor: "color.background.neutral",
  borderColor: "color.border",
  borderWidth: "border.width",
  borderStyle: "solid",
  borderRadius: "radius.medium",
  padding: "space.150"
});

const traceNodeStyle = xcss({
  backgroundColor: "color.background.neutral",
  borderColor: "color.border",
  borderWidth: "border.width",
  borderStyle: "solid",
  borderRadius: "radius.medium",
  padding: "space.100"
});

const TraceTreeView: React.FC<{
  readonly title: string;
  readonly node: PredicateTraceNode;
}> = ({ title, node }) => {
  const renderNode = (n: PredicateTraceNode, depth: number, idx: number): React.ReactNode => {
    const indentPrefix = depth > 0 ? `${"  ".repeat(depth)}└─ ` : "";
    return (
      <Stack key={`${depth}-${idx}-${n.exprKind}`} space="space.075">
        <Inline space="space.100" alignBlock="center">
          <Text>{indentPrefix}</Text>
          <Lozenge appearance={truthAppearance(n.value)} isBold maxWidth={340}>
            {n.value}
          </Lozenge>
          <Code>{n.exprKind}</Code>
          <Text>{n.reason}</Text>
        </Inline>
        {n.children
          ? n.children.map((child, childIdx) => renderNode(child, depth + 1, childIdx))
          : null}
      </Stack>
    );
  };

  return (
    <Box xcss={traceNodeStyle}>
      <Stack space="space.100">
        <Heading size="xsmall">{title}</Heading>
        {renderNode(node, 0, 0)}
      </Stack>
    </Box>
  );
};

const LineLockAssuranceCockpit: React.FC = () => {
  const [view, setView] = useState<EcoWorkspaceView | null>(null);
  const [probe, setProbe] = useState<ConnectivityProbeResult | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Industry Template selector
  const [selectedTemplateId, setSelectedTemplateId] =
    useState<IndustryTemplateId>("AUTOMOTIVE_EV_HELIOS");

  // Selected row in Assurance Matrix for Strong Kleene K3 Proof inspection
  const [selectedSliceOblKey, setSelectedSliceOblKey] = useState<string | null>(null);

  // Counterfactual Simulator state
  const [cfKind, setCfKind] = useState<CounterfactualRequest["kind"]>("CAP_REV_C_CUTOVER");
  const [cfVariantScope, setCfVariantScope] = useState<string>("VAR_400V");
  const [cfSerialFrom, setCfSerialFrom] = useState<string>("5000");
  const [cfSerialTo, setCfSerialTo] = useState<string>("");
  const [cfMinAmbient, setCfMinAmbient] = useState<string>("-20");
  const [cfMaxAmbient, setCfMaxAmbient] = useState<string>("58");
  const [cfResult, setCfResult] = useState<CounterfactualSimulationResult | null>(null);
  const [showAuditMarkdown, setShowAuditMarkdown] = useState<boolean>(false);

  // Governance & Attestation form state
  const [selectedRole, setSelectedRole] = useState<string>("Lead Engineers");
  const [rationaleText, setRationaleText] = useState<string>(
    "Verified governed BOM bindings, operating-envelope bounds, and Strong Kleene K3 carry-forward trace."
  );

  // Custom Studio & Live Jira Evidence Binding state
  const [customSlotPath, setCustomSlotPath] = useState<string>("HV_INV/DC_LINK_CAP_C14");
  const [customPartNumber, setCustomPartNumber] = useState<string>("CAP-1210-HV");
  const [customRevision, setCustomRevision] = useState<string>("E");
  const [customTitle, setCustomTitle] = useState<string>(
    "1210 MLCC Capacitor 1100V C0G (400V & 800V Qualified)"
  );
  const [customSpecStatus, setCustomSpecStatus] =
    useState<ItemRevision["specStatus"]>("APPROVED");
  const [customAttrKey, setCustomAttrKey] = useState<string>("v_rated");
  const [customAttrValue, setCustomAttrValue] = useState<string>("1100");
  const [customAttrScale, setCustomAttrScale] = useState<string>("0");
  const [customAttrUnit, setCustomAttrUnit] = useState<string>("V");
  const [customEnumKey, setCustomEnumKey] = useState<string>("dielectric");
  const [customEnumValue, setCustomEnumValue] = useState<string>("C0G");
  const [customVariantScope, setCustomVariantScope] = useState<string>("ALL");
  const [customSerialFrom, setCustomSerialFrom] = useState<string>("5000");
  const [customSerialTo, setCustomSerialTo] = useState<string>("");

  const [bindEvidenceId, setBindEvidenceId] = useState<string>("EV-400-RIPPLE");
  const [bindJiraKey, setBindJiraKey] = useState<string>("");

  const syncTemplateDependentDefaults = (nextView: EcoWorkspaceView): void => {
    const cat = nextView.workspace?.catalog;
    if (cat) {
      const tpl = inferTemplateFromCatalog(cat);
      setSelectedTemplateId(tpl.templateId);
      setCfVariantScope(tpl.flagshipScopedVariantId);
      const defs = defaultStudioFieldsForCatalog(cat);
      setCustomSlotPath(defs.slotPath);
      setCustomPartNumber(defs.partNumber);
      setCustomRevision(defs.revision);
      setCustomTitle(defs.title);
      setCustomAttrKey(defs.attrKey);
      setCustomAttrValue(defs.attrVal);
      setCustomAttrScale(defs.attrScale);
      setCustomAttrUnit(defs.attrUnit);
      setCustomEnumKey(defs.enumKey);
      setCustomEnumValue(defs.enumVal);
      if (cat.evidenceRecords[0]) {
        setBindEvidenceId(cat.evidenceRecords[0].evidenceId);
      }
    }
    if (nextView.evaluation?.attestationSummary.missingRoles[0]) {
      setSelectedRole(nextView.evaluation.attestationSummary.missingRoles[0]);
    }
  };

  const refreshView = async (): Promise<void> => {
    try {
      const res = unwrapInvoke(await invoke<EcoWorkspaceView>("getWorkspaceView"));
      setView(res);
      syncTemplateDependentDefaults(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refreshView();
  }, []);

  const runAction = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusyAction(label);
    setErrorMsg(null);
    setStatusNotice(null);
    try {
      await fn();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleProvisionLiveJira = (): Promise<void> =>
    runAction("provision-live", async () => {
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("provisionLiveJiraWorkspace", {
          templateId: selectedTemplateId
        })
      );
      setView(next);
      setCfResult(null);
      syncTemplateDependentDefaults(next);
      const tpl = inferTemplateFromCatalog(next.workspace?.catalog);
      setStatusNotice(
        `Provisioned 6 live Jira qualification work items for "${tpl.domainLabel}" in Done status and pinned their RFC 8785 SHA-256 content hashes in Forge SQL.`
      );
    });

  const handleSeedOffline = (): Promise<void> =>
    runAction("seed-offline", async () => {
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("seedHeliosWorkspace", {
          templateId: selectedTemplateId
        })
      );
      setView(next);
      setCfResult(null);
      syncTemplateDependentDefaults(next);
      setStatusNotice("Initialized offline reference catalog in Forge SQL.");
    });

  const handleApplyPreset = (presetId: ScenarioPresetId, label: string): Promise<void> =>
    runAction(`preset:${presetId}`, async () => {
      if (!view?.workspace) return;
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("applyScenarioPreset", {
          expectedRevisionSeq: view.workspace.revisionSeq,
          presetId
        })
      );
      setView(next);
      setCfResult(null);
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        `Committed preset "${label}" (CAS rev ${next.workspace?.revisionSeq}, approval generation ${next.workspace?.eco.approvalGeneration}).`
      );
    });

  const handleRunCounterfactual = (): Promise<void> =>
    runAction("sim-cf", async () => {
      const parsedSerial = Math.max(1000, Number.parseInt(cfSerialFrom, 10) || 5000);
      const rawEnd = cfSerialTo.trim();
      const parsedEnd = rawEnd.length > 0 ? Number.parseInt(rawEnd, 10) : Number.NaN;
      const serialTo =
        Number.isFinite(parsedEnd) && parsedEnd > parsedSerial ? parsedEnd : null;
      const targetVariants: "ALL" | readonly string[] =
        cfVariantScope === "ALL" ? "ALL" : [cfVariantScope];
      const fallbackVariant =
        view?.workspace?.catalog.variants[0]?.variantId ?? "VAR_400V";

      const request: CounterfactualRequest =
        cfKind === "AMBIENT_ENVELOPE_SHIFT"
          ? {
              kind: "AMBIENT_ENVELOPE_SHIFT",
              variantId: cfVariantScope === "ALL" ? fallbackVariant : cfVariantScope,
              minAmbientC: safeIntegerOrDefault(cfMinAmbient, -20),
              maxAmbientC: safeIntegerOrDefault(cfMaxAmbient, 58)
            }
          : {
              kind: cfKind,
              targetVariants,
              serialFrom: parsedSerial,
              serialTo
            };

      const res = unwrapInvoke(
        await invoke<CounterfactualSimulationResult>("simulateCounterfactual", {
          request,
          includeBaselines: true
        })
      );
      setCfResult(res);
    });

  const handleCommitCounterfactual = (): Promise<void> =>
    runAction("commit-cf", async () => {
      if (!view?.workspace || !cfResult) return;
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("commitCounterfactualOperations", {
          expectedRevisionSeq: view.workspace.revisionSeq,
          proposedOperations: cfResult.proposedOperations
        })
      );
      setView(next);
      setCfResult(null);
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        `Committed simulated operations via Forge SQL CAS (rev ${next.workspace?.revisionSeq}, approval generation ${next.workspace?.eco.approvalGeneration}).`
      );
    });

  const handleAuthorCustomComponent = (): Promise<void> =>
    runAction("author-custom", async () => {
      if (!view?.workspace) return;
      const parsedSerialFrom = Math.max(1000, Number.parseInt(customSerialFrom, 10) || 5000);
      const rawEnd = customSerialTo.trim();
      const parsedEnd = rawEnd.length > 0 ? Number.parseInt(rawEnd, 10) : Number.NaN;
      const serialTo =
        Number.isFinite(parsedEnd) && parsedEnd > parsedSerialFrom ? parsedEnd : null;

      const request: CustomComponentSubstitutionRequest = {
        partNumber: customPartNumber,
        revision: customRevision,
        title: customTitle,
        specStatus: customSpecStatus,
        targetSlotPath: customSlotPath,
        primaryNumericAttrKey: customAttrKey,
        primaryNumericValue: safeIntegerOrDefault(customAttrValue, 0),
        primaryNumericScale: safeIntegerOrDefault(customAttrScale, 0),
        primaryNumericUnit: customAttrUnit,
        secondaryEnumAttrKey: customEnumKey.trim() || undefined,
        secondaryEnumValue: customEnumValue.trim() || undefined,
        targetVariants: customVariantScope === "ALL" ? "ALL" : [customVariantScope],
        serialFrom: parsedSerialFrom,
        serialTo
      };

      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("authorCustomComponentSubstitution", {
          expectedRevisionSeq: view.workspace.revisionSeq,
          request
        })
      );
      setView(next);
      setCfResult(null);
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        `Authored custom component ${customPartNumber}@${customRevision} (${customSpecStatus}) on ${customSlotPath} and committed serial cutover via SQL CAS (rev ${next.workspace?.revisionSeq}, gen ${next.workspace?.eco.approvalGeneration}).`
      );
    });

  const handleBindCustomJiraTicket = (): Promise<void> =>
    runAction("bind-jira", async () => {
      if (!view?.workspace) return;
      const request: BindJiraEvidenceRequest = {
        evidenceId: bindEvidenceId,
        jiraIssueKeyOrId: bindJiraKey
      };
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("bindCustomJiraEvidenceTicket", {
          expectedRevisionSeq: view.workspace.revisionSeq,
          request
        })
      );
      setView(next);
      setBindJiraKey("");
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        `Bound live Done Jira ticket "${request.jiraIssueKeyOrId}" to ${bindEvidenceId}, pinned its RFC 8785 SHA-256 hash, and incremented approvalGeneration to ${next.workspace?.eco.approvalGeneration}.`
      );
    });

  const handleSwitchPolicyMode = (mode: GovernancePolicyMode): Promise<void> =>
    runAction(`policy:${mode}`, async () => {
      if (!view?.workspace) return;
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("switchGovernancePolicyMode", {
          expectedRevisionSeq: view.workspace.revisionSeq,
          mode
        })
      );
      setView(next);
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        `Updated governance policy to ${mode} (policyVersion=${next.workspace?.catalog.policy.policyVersion}, approvalGeneration=${next.workspace?.eco.approvalGeneration}).`
      );
    });

  const handleSignAttestation = (): Promise<void> =>
    runAction("sign-att", async () => {
      if (!view?.workspace || !view.evaluation) return;
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("signRoleAttestation", {
          expectedRevisionSeq: view.workspace.revisionSeq,
          expectedSnapshotSha256: view.evaluation.snapshotSha256,
          expectedApprovalGeneration: view.workspace.eco.approvalGeneration,
          roleName: selectedRole,
          rationale: rationaleText
        })
      );
      setView(next);
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        `Signed "${selectedRole}" attestation bound to snapshot ${next.evaluation?.snapshotSha256.slice(0, 12)} & generation ${next.workspace?.eco.approvalGeneration}.`
      );
    });

  const handleRepinLiveEvidence = (): Promise<void> =>
    runAction("repin-ev", async () => {
      if (!view?.workspace) return;
      const next = unwrapInvoke(
        await invoke<EcoWorkspaceView>("repinLiveEvidenceHashes", {
          expectedRevisionSeq: view.workspace.revisionSeq
        })
      );
      setView(next);
      setCfResult(null);
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        `Re-pinned live Done Jira qualification SHA-256 hashes via CAS (rev ${next.workspace?.revisionSeq}, approval generation ${next.workspace?.eco.approvalGeneration}; prior attestations invalidated for re-review).`
      );
    });

  const handlePostAuditComment = (): Promise<void> =>
    runAction("post-audit", async () => {
      const res = unwrapInvoke(
        await invoke<{ readonly commentId: string; readonly view: EcoWorkspaceView }>(
          "postAuditRecordComment"
        )
      );
      setView(res.view);
      setStatusNotice(
        `Posted deterministic Release Assurance & Effectivity Disposition Record to Jira comment #${res.commentId}.`
      );
    });

  const handleProbe = (): Promise<void> =>
    runAction("probe", async () => {
      const res = unwrapInvoke(
        await invoke<{
          readonly connectivity: ConnectivityProbeResult;
          readonly provisioning: EcoWorkspaceView["provisioning"];
        }>("probeConnectivity")
      );
      setProbe(res.connectivity);
      await refreshView();
    });

  const handleRecoverSql = (): Promise<void> =>
    runAction("recover-sql", async () => {
      await invoke("triggerProvisioningRecovery");
      await refreshView();
      setStatusNotice("Executed idempotent Forge SQL MigrationRunner check.");
    });

  const evaluation = view?.evaluation ?? null;
  const workspace = view?.workspace ?? null;
  const evidenceIntegrity = view?.evidenceIntegrity ?? [];
  const activeTemplate = inferTemplateFromCatalog(workspace?.catalog);
  const selectedOnboardingTemplate =
    INDUSTRY_TEMPLATES.find((t) => t.templateId === selectedTemplateId) ?? INDUSTRY_TEMPLATES[0]!;

  const supportedCount = evaluation
    ? evaluation.sliceObligations.filter(
        (s) => s.status === "SUPPORTED_AS_TESTED" || s.status === "SUPPORTED_BY_APPROVED_RULE"
      ).length
    : 0;
  const blockedCount = evaluation ? evaluation.sliceObligations.length - supportedCount : 0;
  const minRetestCount = evaluation
    ? evaluation.remediationPlans.reduce((acc, p) => acc + p.selectedActions.length, 0)
    : 0;
  const coverageRatio =
    evaluation && evaluation.sliceObligations.length > 0
      ? supportedCount / evaluation.sliceObligations.length
      : 0;

  const inspectedSliceObl: SliceObligationEvaluation | null =
    evaluation?.sliceObligations.find(
      (s) => `${s.sliceId}::${s.obligationId}` === selectedSliceOblKey
    ) ??
    evaluation?.sliceObligations.find(
      (s) => s.validityTrace !== undefined || s.envelopeTrace !== undefined
    ) ??
    evaluation?.sliceObligations[0] ??
    null;

  // StackBarChart data for Tab 1: Slice x Verdict breakdown
  const sliceStackChartData = evaluation
    ? evaluation.slices.flatMap((sl) => {
        const label = `${sl.variantId} [${sl.interval.serialFrom}..${sl.interval.serialTo ?? "+inf"})`;
        const matching = evaluation.sliceObligations.filter((so) => so.sliceId === sl.sliceId);
        const asTested = matching.filter((m) => m.status === "SUPPORTED_AS_TESTED").length;
        const byRule = matching.filter((m) => m.status === "SUPPORTED_BY_APPROVED_RULE").length;
        const inv = matching.filter((m) => m.status.startsWith("INVALIDATED_")).length;
        const ind = matching.length - asTested - byRule - inv;
        return [
          { slice: label, count: asTested, verdict: "Supported As Tested" },
          { slice: label, count: byRule, verdict: "Supported By K3 Rule" },
          { slice: label, count: inv, verdict: "Invalidated (FALSE)" },
          { slice: label, count: ind, verdict: "Indeterminate / Uncovered" }
        ].filter((d) => d.count > 0);
      })
    : [];

  // BarChart data for Tab 2: Baselines comparison (simulated if active, otherwise live ECO)
  const baselineChartTotals = cfResult?.baselineComparison
    ? {
        b0Supported: cfResult.baselineComparison.b0.filter((x) => x.verdict === "SUPPORTED")
          .length,
        b1Supported: cfResult.baselineComparison.b1.filter((x) => x.verdict === "SUPPORTED")
          .length,
        b2Supported: cfResult.baselineComparison.b2.filter((x) => x.verdict === "SUPPORTED")
          .length,
        linelockSupported: cfResult.delta.simulatedSupportedCount,
        totalSliceObligations: cfResult.simulatedEvaluation.sliceObligations.length
      }
    : view?.baselineSummary;

  const baselineChartData = baselineChartTotals
    ? [
        {
          method: "B0 Timestamp",
          supported: baselineChartTotals.b0Supported,
          series: "B0 Timestamp Freshness"
        },
        {
          method: "B1 ALM Suspect",
          supported: baselineChartTotals.b1Supported,
          series: "B1 Untyped ALM Links"
        },
        {
          method: "B2 PLM Env",
          supported: baselineChartTotals.b2Supported,
          series: "B2 PLM Version + Env"
        },
        {
          method: "LineLock K3",
          supported: baselineChartTotals.linelockSupported,
          series: "LineLock Strong Kleene K3"
        }
      ]
    : [];

  const templateOptions = INDUSTRY_TEMPLATES.map((t) => ({
    label: t.domainLabel,
    value: t.templateId
  }));

  const variantScopeOptions = [
    { label: "ALL Product Variants", value: "ALL" },
    ...(workspace?.catalog.variants.map((v) => ({
      label: `${v.variantId} — ${v.displayName}`,
      value: v.variantId
    })) ?? [])
  ];

  const leafSlots = collectGovernedLeafSlots(workspace?.catalog);

  // Give a generalist judge the release decision before specialized K3 proof traces.
  const unsupportedObligations = evaluation?.sliceObligations.filter(
    (item) => item.status !== "SUPPORTED_AS_TESTED" &&
      item.status !== "SUPPORTED_BY_APPROVED_RULE"
  ) ?? [];
  const affectedVariants = [...new Set(unsupportedObligations.map((item) => item.variantId))];
  const requiredRetests = evaluation?.remediationPlans.reduce(
    (total, plan) => total + plan.selectedActions.length, 0
  ) ?? 0;
  const missingSignoffs = evaluation?.attestationSummary.missingRoles ?? [];
  const executiveNextStep = requiredRetests > 0
    ? `Run ${requiredRetests} targeted qualification ${requiredRetests === 1 ? "test" : "tests"} or use the simulator to narrow the affected serials.`
    : missingSignoffs.length > 0
      ? `Obtain the required signoff: ${missingSignoffs.join(", ")}.`
      : evaluation?.gateState === "RELEASE_TRANSITIONED_VERIFIED"
        ? "The release receipt is recorded and matches the verified evidence."
        : evaluation?.transitionAllowed
          ? "The ECO has satisfied the evidence gate. Complete the controlled Jira transition."
          : "Review the first blocking reason, inspect evidence integrity, and resolve any missing configuration or approvals.";

  return (
    <Stack space="space.200">
      {/* Top Executive Gate Header */}
      <Box xcss={cardBoxStyle}>
        <Stack space="space.150">
          <Inline spread="space-between" alignBlock="center" space="space.150" shouldWrap>
            <Inline space="space.100" alignBlock="center" shouldWrap>
              <Heading size="small">LineLock Assurance Cockpit</Heading>
              {evaluation ? (
                <Lozenge appearance={gateAppearance(evaluation.gateState)} isBold maxWidth={340}>
                  {gateShortLabel(evaluation.gateState)}
                </Lozenge>
              ) : (
                <Lozenge appearance="default">UNINITIALIZED</Lozenge>
              )}
              {evaluation ? (
                <Lozenge
                  appearance={evaluation.transitionAllowed ? "success" : "removed"}
                  isBold
                  maxWidth={340}
                >
                  {evaluation.transitionAllowed ? "RELEASE ALLOWED" : "WORKFLOW LOCKED"}
                </Lozenge>
              ) : null}
            </Inline>

            <Inline space="space.100" alignBlock="center" shouldWrap>
              <LoadingButton
                isLoading={busyAction === "refresh"}
                onClick={() => runAction("refresh", refreshView)}
              >
                Refresh Live State
              </LoadingButton>
              {workspace ? (
                <>
                  <Select
                    options={templateOptions}
                    value={{
                      label: selectedOnboardingTemplate.domainLabel,
                      value: selectedTemplateId
                    }}
                    onChange={(opt: { value?: string } | null) => {
                      const v = opt?.value as IndustryTemplateId | undefined;
                      if (v) setSelectedTemplateId(v);
                    }}
                  />
                  <LoadingButton
                    isLoading={busyAction === "provision-live"}
                    onClick={handleProvisionLiveJira}
                  >
                    Provision Selected Template (6 Live Tests)
                  </LoadingButton>
                </>
              ) : null}
            </Inline>
          </Inline>

          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Tag text={`SQL: ${view?.provisioning.state ?? "CHECKING"}`} color="teal" />
            <Tag text="Forge-native · no external egress" color="blue" />
            {workspace ? (
              <Tag text={activeTemplate.standardReference} color="purple" />
            ) : null}
            {workspace && evaluation ? (
              <>
                <Code>{`Family: ${workspace.catalog.familyId}`}</Code>
                <Code>{`Gate: ${evaluation.gateState}`}</Code>
                <Code>{`SHA-256: ${evaluation.snapshotSha256.slice(0, 12)}...`}</Code>
                <Code>{`Approval Gen: ${workspace.eco.approvalGeneration}`}</Code>
                <Code>{`SQL CAS Rev: ${workspace.revisionSeq}`}</Code>
                <Code>{`Policy: ${workspace.catalog.policy.policyId} (v${workspace.catalog.policy.policyVersion})`}</Code>
              </>
            ) : null}
          </Inline>
        </Stack>
      </Box>

      {workspace && evaluation ? (
        <Box xcss={cardBoxStyle}>
          <Stack space="space.100">
            <Heading size="medium">
              {evaluation.gateState === "RELEASE_TRANSITIONED_VERIFIED"
                ? "Release verified"
                : evaluation.transitionAllowed
                  ? "Release ready for controlled transition"
                  : "Release blocked until verification is complete"}
            </Heading>
            <Text>
              {unsupportedObligations.length > 0
                ? `${unsupportedObligations.length} configuration-specific evidence obligations need attention${affectedVariants.length > 0 ? ` across ${affectedVariants.join(", ")}` : ""}.`
                : "All configuration-specific evidence obligations are supported by recorded tests or approved rules."}
            </Text>
            {evaluation.blockingReasons.length > 0 ? (
              <Text>{`Why: ${evaluation.blockingReasons[0]}`}</Text>
            ) : null}
            <Text>{`Next action: ${executiveNextStep}`}</Text>
            {!workspace.catalog.policy.enforceSeparationOfDuties ? (
              <SectionMessage appearance="warning" title="Evaluation mode: separation of duties waived">
                <Text>
                  This workspace uses a single-evaluator demonstration policy, not the production multi-role approval standard.
                </Text>
              </SectionMessage>
            ) : null}
          </Stack>
        </Box>
      ) : null}

      {errorMsg ? (
        <SectionMessage appearance="error" title="Verification / Governance Rejection">
          <Text>{errorMsg}</Text>
        </SectionMessage>
      ) : null}

      {statusNotice ? (
        <SectionMessage appearance="success" title="State Updated">
          <Text>{statusNotice}</Text>
        </SectionMessage>
      ) : null}

      {/* Provisioning Not Ready Guard */}
      {view && view.provisioning.state !== "READY" ? (
        <SectionMessage
          appearance="warning"
          title={`Forge SQL Storage: ${view.provisioning.state}`}
        >
          <Stack space="space.100">
            <Text>
              {view.provisioning.lastErrorMessage ??
                "Forge SQL schema migrations have not completed yet. Workflow transitions fail closed until READY."}
            </Text>
            <Inline space="space.100">
              <LoadingButton
                appearance="primary"
                isLoading={busyAction === "recover-sql"}
                onClick={handleRecoverSql}
              >
                Run Idempotent SQL Migration Recovery
              </LoadingButton>
            </Inline>
          </Stack>
        </SectionMessage>
      ) : null}

      {/* Unseeded Multi-Industry Onboarding View */}
      {view?.provisioning.state === "READY" && !workspace ? (
        <Box xcss={cardBoxStyle}>
          <Stack space="space.150">
            <Heading size="small">
              Initialize Regulated Hardware Engineering Change Order (Multi-Industry)
            </Heading>
            <Stack space="space.050">
              <Text>Select Regulated Hardware Industry Domain Template</Text>
              <Select
                options={templateOptions}
                value={{
                  label: selectedOnboardingTemplate.domainLabel,
                  value: selectedTemplateId
                }}
                onChange={(opt: { value?: string } | null) => {
                  const v = opt?.value as IndustryTemplateId | undefined;
                  if (v) setSelectedTemplateId(v);
                }}
              />
            </Stack>
            <Inline space="space.100" alignBlock="center" shouldWrap>
              <Tag text={selectedOnboardingTemplate.standardReference} color="purple" />
              <Text>{selectedOnboardingTemplate.summary}</Text>
            </Inline>
            <Text>
              LineLock will create 6 real Jira qualification work items in this space, transition
              each to Done, link them to this ECO, and pin their live RFC 8785 SHA-256 content
              hashes in Forge SQL. You can also author custom components and bind your own Jira
              tickets in the Custom Studio tab.
            </Text>
            <Inline space="space.100" shouldWrap>
              <LoadingButton
                appearance="primary"
                isLoading={busyAction === "provision-live"}
                onClick={handleProvisionLiveJira}
              >
                Provision 6 Live Jira Qualification Tests (Recommended)
              </LoadingButton>
              <LoadingButton
                isLoading={busyAction === "seed-offline"}
                onClick={handleSeedOffline}
              >
                Seed Offline Reference IDs Only
              </LoadingButton>
            </Inline>
          </Stack>
        </Box>
      ) : null}

      {/* Main 5-Tab Engineering Cockpit */}
      {workspace && evaluation ? (
        <Tabs id="linelock-cockpit-tabs">
          <TabList>
            <Tab>Evidence &amp; K3</Tab>
            <Tab>Simulate &amp; Fix</Tab>
            <Tab>Custom Engineering</Tab>
            <Tab>Approvals &amp; SoD</Tab>
            <Tab>Jira Audit</Tab>
          </TabList>

          {/* TAB 1: ASSURANCE MATRIX & K3 PROOF */}
          <TabPanel>
            <Stack space="space.200">
              <Inline space="space.150" shouldWrap>
                <Box xcss={metricCardStyle}>
                  <Stack space="space.050">
                    <Text>Effective Serial Slices</Text>
                    <Heading size="medium">{String(evaluation.slices.length)}</Heading>
                  </Stack>
                </Box>
                <Box xcss={metricCardStyle}>
                  <Stack space="space.050">
                    <Text>Supported Obligations</Text>
                    <Heading size="medium">
                      {`${supportedCount} / ${evaluation.sliceObligations.length}`}
                    </Heading>
                  </Stack>
                </Box>
                <Box xcss={metricCardStyle}>
                  <Stack space="space.050">
                    <Text>Invalidated / Blocked</Text>
                    <Heading size="medium">{String(blockedCount)}</Heading>
                  </Stack>
                </Box>
                <Box xcss={metricCardStyle}>
                  <Stack space="space.050">
                    <Text>Minimum Physical Retests</Text>
                    <Heading size="medium">{String(minRetestCount)}</Heading>
                  </Stack>
                </Box>
              </Inline>

              <Box xcss={traceNodeStyle}>
                <Stack space="space.075">
                  <Inline spread="space-between" alignBlock="center">
                    <Text>Effectivity-Scoped Assurance Coverage</Text>
                    <Code>{`${Math.round(coverageRatio * 100)}% (${supportedCount}/${evaluation.sliceObligations.length})`}</Code>
                  </Inline>
                  <ProgressBar
                    ariaLabel="Assurance obligation coverage"
                    appearance={coverageRatio >= 1 ? "success" : "default"}
                    value={coverageRatio}
                  />
                </Stack>
              </Box>

              {sliceStackChartData.length > 0 ? (
                <Box xcss={traceNodeStyle}>
                  <StackBarChart
                    title="Assurance Verdicts by Variant & Effective Serial Interval"
                    subtitle="Live Strong Kleene K3 disposition across refined unit serial partitions"
                    data={sliceStackChartData}
                    xAccessor="slice"
                    yAccessor="count"
                    colorAccessor="verdict"
                    height={240}
                  />
                </Box>
              ) : null}

              <Box xcss={cardBoxStyle}>
                <Stack space="space.100">
                  <Heading size="xsmall">
                    Commit Engineering Change Scenario (CAS + Gen Increment)
                  </Heading>
                  <Inline space="space.100" shouldWrap>
                    <LoadingButton
                      isLoading={busyAction === "preset:CAP_REV_C_ALL_5000"}
                      onClick={() =>
                        handleApplyPreset(
                          "CAP_REV_C_ALL_5000",
                          activeTemplate.flagshipCutoverLabel
                        )
                      }
                    >
                      {activeTemplate.flagshipCutoverLabel}
                    </LoadingButton>
                    <LoadingButton
                      appearance="primary"
                      isLoading={busyAction === "preset:CAP_REV_C_400V_5000"}
                      onClick={() =>
                        handleApplyPreset(
                          "CAP_REV_C_400V_5000",
                          activeTemplate.flagshipScopedLabel
                        )
                      }
                    >
                      {activeTemplate.flagshipScopedLabel}
                    </LoadingButton>
                    <LoadingButton
                      isLoading={busyAction === "preset:COLD_SOAK_MINUS_40C"}
                      onClick={() =>
                        handleApplyPreset(
                          "COLD_SOAK_MINUS_40C",
                          "Extreme Cold-Soak Envelope Regression"
                        )
                      }
                    >
                      Test Cold-Soak Envelope Regression
                    </LoadingButton>
                    <LoadingButton
                      isLoading={busyAction === "preset:SEAL_REV_B_3000"}
                      onClick={() =>
                        handleApplyPreset("SEAL_REV_B_3000", "Seal Rev B Excluded-Slot Check")
                      }
                    >
                      Test Excluded Seal Rev B (SN&gt;=3000)
                    </LoadingButton>
                    <LoadingButton
                      isLoading={busyAction === "preset:BASELINE"}
                      onClick={() => handleApplyPreset("BASELINE", "Revert to Baseline BOM")}
                    >
                      Revert to Baseline BOM
                    </LoadingButton>
                  </Inline>
                </Stack>
              </Box>

              {evaluation.blockingReasons.length > 0 ? (
                <SectionMessage
                  appearance={
                    evaluation.gateState === "AWAITING_ATTESTATION" ? "information" : "warning"
                  }
                  title={`Active Release Gate Blockers (${evaluation.blockingReasons.length})`}
                >
                  <Stack space="space.050">
                    {evaluation.blockingReasons.map((reason, idx) => (
                      <Text key={`blk-${idx}`}>{`• ${reason}`}</Text>
                    ))}
                  </Stack>
                </SectionMessage>
              ) : null}

              <DynamicTable
                caption="Effectivity-Scoped Slice × Obligation Assurance Matrix"
                head={{
                  cells: [
                    { key: "slice", content: "Variant & Serial Effectivity" },
                    { key: "obl", content: "Obligation" },
                    { key: "verdict", content: "Assurance Verdict" },
                    { key: "evidence", content: "Evidence / Rule" },
                    { key: "inspect", content: "Proof" }
                  ]
                }}
                rows={evaluation.sliceObligations.map((so) => {
                  const rowKey = `${so.sliceId}::${so.obligationId}`;
                  const evRow = evidenceIntegrity.find(
                    (e) => e.evidenceId === so.supportingEvidenceId
                  );
                  return {
                    key: rowKey,
                    cells: [
                      {
                        key: "slice",
                        content: (
                          <Stack space="space.050">
                            <Code>{so.variantId}</Code>
                            <Text>{formatSerialRange(so.interval)}</Text>
                          </Stack>
                        )
                      },
                      {
                        key: "obl",
                        content: <Code>{so.obligationCode}</Code>
                      },
                      {
                        key: "verdict",
                        content: (
                          <Stack space="space.050">
                            <Lozenge
                              appearance={sliceStatusAppearance(so.status)}
                              isBold
                              maxWidth={340}
                            >
                              {sliceShortLabel(so.status)}
                            </Lozenge>
                            <Code>{so.status}</Code>
                          </Stack>
                        )
                      },
                      {
                        key: "evidence",
                        content: (
                          <Stack space="space.050">
                            <Text>
                              {evRow
                                ? `${evRow.jiraIssueKey} (${so.supportingEvidenceId})`
                                : (so.supportingEvidenceId ?? "None")}
                            </Text>
                            {so.appliedCarryForwardRuleId ? (
                              <Code>{`Rule: ${so.appliedCarryForwardRuleId}`}</Code>
                            ) : null}
                          </Stack>
                        )
                      },
                      {
                        key: "inspect",
                        content: (
                          <Button
                            appearance={
                              inspectedSliceObl &&
                              `${inspectedSliceObl.sliceId}::${inspectedSliceObl.obligationId}` ===
                                rowKey
                                ? "primary"
                                : "default"
                            }
                            onClick={() => setSelectedSliceOblKey(rowKey)}
                          >
                            Inspect
                          </Button>
                        )
                      }
                    ]
                  };
                })}
              />

              {/* Selected Slice-Obligation Strong Kleene K3 Proof Inspector */}
              {inspectedSliceObl ? (
                <Box xcss={cardBoxStyle}>
                  <Stack space="space.150">
                    <Inline spread="space-between" alignBlock="center" shouldWrap>
                      <Heading size="xsmall">
                        {`Proof Trace: ${inspectedSliceObl.variantId} ${formatSerialRange(inspectedSliceObl.interval)} — ${inspectedSliceObl.obligationCode}`}
                      </Heading>
                      <Inline space="space.100" alignBlock="center">
                        <Lozenge
                          appearance={sliceStatusAppearance(inspectedSliceObl.status)}
                          isBold
                          maxWidth={340}
                        >
                          {sliceShortLabel(inspectedSliceObl.status)}
                        </Lozenge>
                        <Code>{inspectedSliceObl.status}</Code>
                      </Inline>
                    </Inline>
                    <Text>{inspectedSliceObl.explanation}</Text>

                    <Inline space="space.150" shouldWrap>
                      <Code>
                        {`Changed Governed Slots: ${
                          inspectedSliceObl.changedGovernedSlots.length > 0
                            ? inspectedSliceObl.changedGovernedSlots.join(", ")
                            : "none"
                        }`}
                      </Code>
                      <Code>
                        {`Changed Envelope Keys: ${
                          inspectedSliceObl.changedGovernedEnvelopeKeys.length > 0
                            ? inspectedSliceObl.changedGovernedEnvelopeKeys.join(", ")
                            : "none"
                        }`}
                      </Code>
                      <Code>
                        {`Justified Excluded Changes: ${
                          inspectedSliceObl.changedExcludedSlots.length > 0
                            ? inspectedSliceObl.changedExcludedSlots.join(", ")
                            : "none"
                        }`}
                      </Code>
                    </Inline>

                    {inspectedSliceObl.envelopeTrace ? (
                      <TraceTreeView
                        title="Operating-Envelope Predicate Trace (Strong Kleene K3)"
                        node={inspectedSliceObl.envelopeTrace}
                      />
                    ) : null}

                    {inspectedSliceObl.validityTrace ? (
                      <TraceTreeView
                        title="Component Carry-Forward Validity Predicate Trace (Strong Kleene K3)"
                        node={inspectedSliceObl.validityTrace}
                      />
                    ) : null}
                  </Stack>
                </Box>
              ) : null}
            </Stack>
          </TabPanel>

          {/* TAB 2: COUNTERFACTUAL SIMULATOR & EXACT REMEDIATION */}
          <TabPanel>
            <Stack space="space.200">
              <Box xcss={cardBoxStyle}>
                <Stack space="space.150">
                  <Heading size="small">
                    Read-Only Parametric Counterfactual Simulator (Zero Storage Mutation)
                  </Heading>
                  <Text>
                    Simulate arbitrary serial-interval component substitutions (open-ended or
                    lot-bounded [SN_from..SN_to)), unapproved DRAFT sample gates, uncovered
                    governed-slot changes, or operating-envelope shifts against live Jira evidence
                    before committing to Forge SQL.
                  </Text>

                  <Inline space="space.150" shouldWrap alignBlock="end">
                    <Stack space="space.050">
                      <Text>Counterfactual Engineering Operation</Text>
                      <Select
                        options={[
                          {
                            label: "Flagship Second-Source Substitution",
                            value: "CAP_REV_C_CUTOVER"
                          },
                          {
                            label: "Unapproved Engineering Sample (DRAFT Gate)",
                            value: "CAP_REV_D_DRAFT_CUTOVER"
                          },
                          {
                            label: "Uncovered Governed Slot Substitution",
                            value: "GATE_DRIVER_REV_B_CUTOVER"
                          },
                          {
                            label: "Excluded Seal / Breather Substitution",
                            value: "SEAL_REV_B_CUTOVER"
                          },
                          {
                            label: "Shift Operating Ambient Temperature Envelope",
                            value: "AMBIENT_ENVELOPE_SHIFT"
                          }
                        ]}
                        value={{
                          label:
                            cfKind === "CAP_REV_C_CUTOVER"
                              ? "Flagship Second-Source Substitution"
                              : cfKind === "CAP_REV_D_DRAFT_CUTOVER"
                                ? "Unapproved Engineering Sample (DRAFT Gate)"
                                : cfKind === "GATE_DRIVER_REV_B_CUTOVER"
                                  ? "Uncovered Governed Slot Substitution"
                                  : cfKind === "SEAL_REV_B_CUTOVER"
                                    ? "Excluded Seal / Breather Substitution"
                                    : "Shift Operating Ambient Temperature Envelope",
                          value: cfKind
                        }}
                        onChange={(opt: { value?: string } | null) => {
                          const v = opt?.value;
                          if (
                            v === "CAP_REV_C_CUTOVER" ||
                            v === "CAP_REV_D_DRAFT_CUTOVER" ||
                            v === "GATE_DRIVER_REV_B_CUTOVER" ||
                            v === "SEAL_REV_B_CUTOVER" ||
                            v === "AMBIENT_ENVELOPE_SHIFT"
                          ) {
                            setCfKind(v);
                          }
                        }}
                      />
                    </Stack>

                    <Stack space="space.050">
                      <Text>Target Variant Scope</Text>
                      <Select
                        options={variantScopeOptions}
                        value={
                          variantScopeOptions.find((o) => o.value === cfVariantScope) ??
                          variantScopeOptions[0]!
                        }
                        onChange={(opt: { value?: string } | null) => {
                          if (opt?.value) setCfVariantScope(opt.value);
                        }}
                      />
                    </Stack>

                    {cfKind !== "AMBIENT_ENVELOPE_SHIFT" ? (
                      <>
                        <Stack space="space.050">
                          <Text>Serial Start (SN &gt;=)</Text>
                          <Textfield
                            value={cfSerialFrom}
                            onChange={(e) => setCfSerialFrom(extractEventString(e))}
                          />
                        </Stack>
                        <Stack space="space.050">
                          <Text>Serial End (SN &lt;, blank = +inf)</Text>
                          <Textfield
                            placeholder="+inf (open-ended)"
                            value={cfSerialTo}
                            onChange={(e) => setCfSerialTo(extractEventString(e))}
                          />
                        </Stack>
                      </>
                    ) : (
                      <>
                        <Stack space="space.050">
                          <Text>Min Ambient (degC)</Text>
                          <Textfield
                            value={cfMinAmbient}
                            onChange={(e) => setCfMinAmbient(extractEventString(e))}
                          />
                        </Stack>
                        <Stack space="space.050">
                          <Text>Max Ambient (degC)</Text>
                          <Textfield
                            value={cfMaxAmbient}
                            onChange={(e) => setCfMaxAmbient(extractEventString(e))}
                          />
                        </Stack>
                      </>
                    )}

                    <LoadingButton
                      appearance="primary"
                      isLoading={busyAction === "sim-cf"}
                      onClick={handleRunCounterfactual}
                    >
                      Run Counterfactual Simulation
                    </LoadingButton>
                  </Inline>

                  {cfResult ? (
                    <Box xcss={traceNodeStyle}>
                      <Stack space="space.150">
                        <Inline spread="space-between" alignBlock="center" shouldWrap>
                          <Inline space="space.100" alignBlock="center">
                            <Heading size="xsmall">Counterfactual Delta Result</Heading>
                            <Tag text="SQL Mutated: FALSE" color="green" />
                            <Tag
                              text={`Effective Slices: ${cfResult.simulatedEvaluation.slices.length}`}
                              color="blue"
                            />
                          </Inline>
                          <LoadingButton
                            appearance="primary"
                            isLoading={busyAction === "commit-cf"}
                            onClick={handleCommitCounterfactual}
                          >
                            Commit Counterfactual to ECO (CAS)
                          </LoadingButton>
                        </Inline>

                        <Inline space="space.150" shouldWrap>
                          <Code>{`Gate: ${cfResult.delta.currentGateState} -> ${cfResult.delta.simulatedGateState}`}</Code>
                          <Code>{`Supported: ${cfResult.delta.currentSupportedCount} -> ${cfResult.delta.simulatedSupportedCount}`}</Code>
                          <Code>{`Blocked: ${cfResult.delta.currentBlockedCount} -> ${cfResult.delta.simulatedBlockedCount}`}</Code>
                          <Code>{`Required Retests: ${cfResult.delta.currentRequiredRetests} -> ${cfResult.delta.simulatedRequiredRetests}`}</Code>
                        </Inline>

                        {cfResult.simulatedEvaluation.blockingReasons.map((r, i) => (
                          <Text key={`sim-blk-${i}`}>{`• ${r}`}</Text>
                        ))}
                      </Stack>
                    </Box>
                  ) : null}
                </Stack>
              </Box>

              {/* Baseline Discrepancy BarChart */}
              {baselineChartData.length > 0 && baselineChartTotals ? (
                <Box xcss={traceNodeStyle}>
                  <BarChart
                    title={
                      cfResult
                        ? "Simulated Baseline Comparison (Why Traditional PLM/ALM Fails)"
                        : "Active ECO Baseline Comparison (Why Traditional PLM/ALM Fails)"
                    }
                    subtitle={`Supported slice × obligations out of ${baselineChartTotals.totalSliceObligations} total`}
                    data={baselineChartData}
                    xAccessor="method"
                    yAccessor="supported"
                    colorAccessor="series"
                    height={240}
                  />
                </Box>
              ) : null}

              {/* Exact Bounded Set-Cover Remediation Plan */}
              <Box xcss={cardBoxStyle}>
                <Stack space="space.150">
                  <Heading size="small">Minimum Verification Remediation Plan</Heading>
                  {evaluation.remediationPlans.length === 0 ? (
                    <SectionMessage
                      appearance="success"
                      title="Zero Physical Retests Required"
                    >
                      <Text>
                        All effective serial slices and product variants are currently supported by
                        exact qualification evidence or approved Strong Kleene K3 carry-forward
                        rules.
                      </Text>
                    </SectionMessage>
                  ) : (
                    evaluation.remediationPlans.map((plan) => (
                      <Box key={plan.obligationId} xcss={traceNodeStyle}>
                        <Stack space="space.100">
                          <Inline spread="space-between" alignBlock="center">
                            <Heading size="xsmall">
                              {`Obligation ${plan.obligationCode} (${plan.unsatisfiedSliceIds.length} unsatisfied slice(s))`}
                            </Heading>
                            <Lozenge appearance="inprogress" isBold maxWidth={340}>
                              {`SOLVER: ${plan.solverMode}`}
                            </Lozenge>
                          </Inline>
                          {plan.selectedActions.map((act) => (
                            <Stack key={act.candidateId} space="space.050">
                              <Text>
                                {`• Execute ${act.obligationCode} on ${act.targetVariantId} ${formatSerialRange(act.targetInterval)} -> covers [${act.coveredSliceIds.join(", ")}]`}
                              </Text>
                              <Code>{`Required Article Binding: ${JSON.stringify(act.requiredSlotBindings)}`}</Code>
                              <Text>{act.reason}</Text>
                            </Stack>
                          ))}
                        </Stack>
                      </Box>
                    ))
                  )}
                </Stack>
              </Box>
            </Stack>
          </TabPanel>

          {/* TAB 3: CUSTOM COMPONENT STUDIO & LIVE JIRA EVIDENCE BINDING */}
          <TabPanel>
            <Stack space="space.200">
              <Box xcss={cardBoxStyle}>
                <Stack space="space.150">
                  <Heading size="small">
                    Interactive Custom Component &amp; Serial-Effectivity Authoring Studio
                  </Heading>
                  <Text>
                    Define any custom component revision (APPROVED or unapproved DRAFT sample),
                    specify its quantitative and enumerated engineering attributes, and commit a
                    variant- and serial-scoped BOM substitution directly into Forge SQL TiDB via
                    optimistic CAS. LineLock evaluates your custom specification live through its
                    Strong Kleene K3 engine.
                  </Text>

                  <Inline space="space.150" shouldWrap alignBlock="end">
                    <Stack space="space.050">
                      <Text>Governed BOM Slot Path</Text>
                      <Select
                        options={leafSlots.map((sp) => ({ label: sp, value: sp }))}
                        value={{ label: customSlotPath, value: customSlotPath }}
                        onChange={(opt: { value?: string } | null) => {
                          if (opt?.value) setCustomSlotPath(opt.value);
                        }}
                      />
                    </Stack>

                    <Stack space="space.050">
                      <Text>Part Number</Text>
                      <Textfield
                        value={customPartNumber}
                        onChange={(e) => setCustomPartNumber(extractEventString(e))}
                      />
                    </Stack>

                    <Stack space="space.050">
                      <Text>Revision</Text>
                      <Textfield
                        value={customRevision}
                        onChange={(e) => setCustomRevision(extractEventString(e))}
                      />
                    </Stack>

                    <Stack space="space.050">
                      <Text>Release Specification Status</Text>
                      <Select
                        options={[
                          { label: "APPROVED (Production Released)", value: "APPROVED" },
                          { label: "DRAFT (Unapproved Sample — Blocks Gate)", value: "DRAFT" }
                        ]}
                        value={{
                          label:
                            customSpecStatus === "APPROVED"
                              ? "APPROVED (Production Released)"
                              : "DRAFT (Unapproved Sample — Blocks Gate)",
                          value: customSpecStatus
                        }}
                        onChange={(opt: { value?: string } | null) => {
                          if (opt?.value === "APPROVED" || opt?.value === "DRAFT") {
                            setCustomSpecStatus(opt.value);
                          }
                        }}
                      />
                    </Stack>
                  </Inline>

                  <Stack space="space.050">
                    <Text>Component Engineering Description</Text>
                    <Textfield
                      value={customTitle}
                      onChange={(e) => setCustomTitle(extractEventString(e))}
                    />
                  </Stack>

                  <Inline space="space.150" shouldWrap alignBlock="end">
                    <Stack space="space.050">
                      <Text>Primary Quantitative Attr Key</Text>
                      <Textfield
                        value={customAttrKey}
                        onChange={(e) => setCustomAttrKey(extractEventString(e))}
                      />
                    </Stack>
                    <Stack space="space.050">
                      <Text>Mantissa (Integer)</Text>
                      <Textfield
                        value={customAttrValue}
                        onChange={(e) => setCustomAttrValue(extractEventString(e))}
                      />
                    </Stack>
                    <Stack space="space.050">
                      <Text>10^Scale (e.g. 0 or -1)</Text>
                      <Textfield
                        value={customAttrScale}
                        onChange={(e) => setCustomAttrScale(extractEventString(e))}
                      />
                    </Stack>
                    <Stack space="space.050">
                      <Text>Physical Unit (V, degC, pct...)</Text>
                      <Textfield
                        value={customAttrUnit}
                        onChange={(e) => setCustomAttrUnit(extractEventString(e))}
                      />
                    </Stack>
                  </Inline>

                  <Inline space="space.150" shouldWrap alignBlock="end">
                    <Stack space="space.050">
                      <Text>Optional Enum Attr Key</Text>
                      <Textfield
                        placeholder="e.g. dielectric"
                        value={customEnumKey}
                        onChange={(e) => setCustomEnumKey(extractEventString(e))}
                      />
                    </Stack>
                    <Stack space="space.050">
                      <Text>Optional Enum Value</Text>
                      <Textfield
                        placeholder="e.g. C0G or X7R"
                        value={customEnumValue}
                        onChange={(e) => setCustomEnumValue(extractEventString(e))}
                      />
                    </Stack>
                    <Stack space="space.050">
                      <Text>Target Variant Scope</Text>
                      <Select
                        options={variantScopeOptions}
                        value={
                          variantScopeOptions.find((o) => o.value === customVariantScope) ??
                          variantScopeOptions[0]!
                        }
                        onChange={(opt: { value?: string } | null) => {
                          if (opt?.value) setCustomVariantScope(opt.value);
                        }}
                      />
                    </Stack>
                    <Stack space="space.050">
                      <Text>Serial Start (SN &gt;=)</Text>
                      <Textfield
                        value={customSerialFrom}
                        onChange={(e) => setCustomSerialFrom(extractEventString(e))}
                      />
                    </Stack>
                    <Stack space="space.050">
                      <Text>Serial End (blank = +inf)</Text>
                      <Textfield
                        placeholder="+inf"
                        value={customSerialTo}
                        onChange={(e) => setCustomSerialTo(extractEventString(e))}
                      />
                    </Stack>
                  </Inline>

                  <Inline space="space.100">
                    <LoadingButton
                      appearance="primary"
                      isLoading={busyAction === "author-custom"}
                      onClick={handleAuthorCustomComponent}
                    >
                      Commit Custom Component &amp; Serial Cutover (SQL CAS)
                    </LoadingButton>
                  </Inline>
                </Stack>
              </Box>

              {/* Bind Existing Live Jira Ticket as Pinned Evidence */}
              <Box xcss={cardBoxStyle}>
                <Stack space="space.150">
                  <Heading size="small">
                    Bind Existing Live Jira Work Item as Content-Pinned Qualification Evidence
                  </Heading>
                  <Text>
                    Already track qualification test protocols as Jira work items in your space?
                    Select an obligation evidence slot below and enter any live Jira issue key in
                    Done status. LineLock verifies live statusCategory=done, registers workflow
                    pass-through, pins its canonical RFC 8785 SHA-256 hash, and increments
                    approvalGeneration.
                  </Text>

                  <Inline space="space.150" shouldWrap alignBlock="end">
                    <Stack space="space.050">
                      <Text>Target Verification Evidence Slot</Text>
                      <Select
                        options={workspace.catalog.evidenceRecords.map((ev) => ({
                          label: `${ev.evidenceId} (${ev.testedVariantId} -> currently ${ev.jiraIssueKey})`,
                          value: ev.evidenceId
                        }))}
                        value={{
                          label: `${bindEvidenceId}`,
                          value: bindEvidenceId
                        }}
                        onChange={(opt: { value?: string } | null) => {
                          if (opt?.value) setBindEvidenceId(opt.value);
                        }}
                      />
                    </Stack>

                    <Stack space="space.050">
                      <Text>Live Done Jira Issue Key (e.g. ECO-8)</Text>
                      <Textfield
                        placeholder="ECO-8"
                        value={bindJiraKey}
                        onChange={(e) => setBindJiraKey(extractEventString(e))}
                      />
                    </Stack>

                    <LoadingButton
                      appearance="primary"
                      isLoading={busyAction === "bind-jira"}
                      onClick={handleBindCustomJiraTicket}
                    >
                      Bind Done Jira Ticket &amp; Pin SHA-256 Hash
                    </LoadingButton>
                  </Inline>
                </Stack>
              </Box>
            </Stack>
          </TabPanel>

          {/* TAB 4: GOVERNANCE, SEPARATION OF DUTIES & ABA SIGNOFF */}
          <TabPanel>
            <Stack space="space.200">
              <Box xcss={cardBoxStyle}>
                <Stack space="space.150">
                  <Inline spread="space-between" alignBlock="center">
                    <Heading size="small">
                      Policy-Version &amp; Approval-Generation Governance
                    </Heading>
                    <Lozenge
                      appearance={
                        workspace.catalog.policy.enforceSeparationOfDuties ? "inprogress" : "moved"
                      }
                      isBold
                      maxWidth={340}
                    >
                      {workspace.catalog.policy.enforceSeparationOfDuties
                        ? "MULTI-ROLE SEPARATION OF DUTIES"
                        : "SOLO-EVALUATOR DEMO POLICY"}
                    </Lozenge>
                  </Inline>

                  <Text>
                    Every attestation binds (snapshotSha256, approvalGeneration, policyVersion). Any
                    intervening BOM or policy edit—even an H1 -&gt; H2 -&gt; H1 revert—increments
                    approvalGeneration and invalidates prior signatures.
                  </Text>

                  <Inline space="space.100" shouldWrap>
                    <LoadingButton
                      isLoading={busyAction === "policy:PRODUCTION_MULTI_ROLE"}
                      onClick={() => handleSwitchPolicyMode("PRODUCTION_MULTI_ROLE")}
                    >
                      Enforce Production Multi-Role Policy (SoD)
                    </LoadingButton>
                    <LoadingButton
                      isLoading={busyAction === "policy:DEMO_SOLO_ADMIN"}
                      onClick={() => handleSwitchPolicyMode("DEMO_SOLO_ADMIN")}
                    >
                      Switch to Solo-Evaluator Demo Policy (Administrators Role)
                    </LoadingButton>
                  </Inline>

                  <Inline space="space.100" shouldWrap>
                    <Code>{`Required Roles: ${evaluation.attestationSummary.requiredRoles.join(", ")}`}</Code>
                    <Code>{`Satisfied: ${evaluation.attestationSummary.satisfiedRoles.join(", ") || "none"}`}</Code>
                    <Code>{`Missing: ${evaluation.attestationSummary.missingRoles.join(", ") || "none"}`}</Code>
                  </Inline>

                  {workspace.finalizedReleaseReceipt ? (
                    <SectionMessage
                      appearance="success"
                      title="Phase-2 Finalized Release Receipt Verified"
                    >
                      <Text>
                        {`Receipt ${workspace.finalizedReleaseReceipt.receiptId} verified snapshot ${workspace.finalizedReleaseReceipt.verifiedSnapshotSha256.slice(0, 16)} at generation ${workspace.finalizedReleaseReceipt.verifiedApprovalGeneration} (policy v${workspace.finalizedReleaseReceipt.verifiedPolicyVersion}).`}
                      </Text>
                    </SectionMessage>
                  ) : null}
                </Stack>
              </Box>

              {/* Sign Role Attestation Form */}
              <Box xcss={cardBoxStyle}>
                <Stack space="space.150">
                  <Heading size="small">Sign Generation-Bound Role Attestation</Heading>
                  <Stack space="space.050">
                    <Text>Target Jira Project Role</Text>
                    <Select
                      options={evaluation.attestationSummary.requiredRoles.map((r) => ({
                        label: r,
                        value: r
                      }))}
                      value={{ label: selectedRole, value: selectedRole }}
                      onChange={(opt: { value?: string } | null) => {
                        if (opt?.value) setSelectedRole(opt.value);
                      }}
                    />
                  </Stack>

                  <Stack space="space.050">
                    <Text>Engineering Disposition Rationale</Text>
                    <TextArea
                      value={rationaleText}
                      onChange={(e) => setRationaleText(extractEventString(e))}
                    />
                  </Stack>

                  <Inline space="space.100" alignBlock="center">
                    <LoadingButton
                      appearance="primary"
                      isLoading={busyAction === "sign-att"}
                      onClick={handleSignAttestation}
                    >
                      {`Sign Snapshot ${evaluation.snapshotSha256.slice(0, 8)} (Gen ${workspace.eco.approvalGeneration})`}
                    </LoadingButton>
                  </Inline>
                </Stack>
              </Box>

              {/* Accepted & Rejected Attestations Audit Log */}
              <Box xcss={cardBoxStyle}>
                <Stack space="space.100">
                  <Heading size="xsmall">
                    {`Accepted Attestations (${evaluation.attestationSummary.acceptedAttestations.length})`}
                  </Heading>
                  {evaluation.attestationSummary.acceptedAttestations.length === 0 ? (
                    <Text>
                      No valid attestations recorded for the current snapshot &amp; generation.
                    </Text>
                  ) : (
                    evaluation.attestationSummary.acceptedAttestations.map((att) => (
                      <Inline key={att.attestationId} space="space.100" shouldWrap>
                        <Lozenge appearance="success" isBold maxWidth={340}>
                          {att.roleName}
                        </Lozenge>
                        <Code>{`Signer: ${att.signerAccountId}`}</Code>
                        <Code>{`Gen ${att.attestedApprovalGeneration} / Policy v${att.attestedPolicyVersion}`}</Code>
                        <Text>{att.rationale}</Text>
                      </Inline>
                    ))
                  )}

                  {evaluation.attestationSummary.rejectedReasons.length > 0 ? (
                    <>
                      <Heading size="xsmall">
                        {`Invalidated / Rejected Prior Attestations (${evaluation.attestationSummary.rejectedReasons.length})`}
                      </Heading>
                      {evaluation.attestationSummary.rejectedReasons.map((rej) => (
                        <Inline key={rej.attestationId} space="space.100" shouldWrap>
                          <Lozenge appearance="removed" isBold maxWidth={340}>
                            INVALIDATED
                          </Lozenge>
                          <Code>{rej.attestationId.slice(0, 12)}</Code>
                          <Text>{rej.reason}</Text>
                        </Inline>
                      ))}
                    </>
                  ) : null}
                </Stack>
              </Box>

              {/* Deterministic Release Assurance & Effectivity Disposition Record Export */}
              {view?.releaseAssuranceMarkdown ? (
                <Box xcss={cardBoxStyle}>
                  <Stack space="space.150">
                    <Inline spread="space-between" alignBlock="center" shouldWrap>
                      <Heading size="xsmall">
                        Deterministic Release Assurance &amp; Effectivity Disposition Record
                      </Heading>
                      <Inline space="space.100" shouldWrap>
                        <LoadingButton
                          appearance="primary"
                          isLoading={busyAction === "post-audit"}
                          onClick={handlePostAuditComment}
                        >
                          Post Audit Record Comment to ECO
                        </LoadingButton>
                        <Button onClick={() => setShowAuditMarkdown((prev) => !prev)}>
                          {showAuditMarkdown
                            ? "Hide Disposition Markdown"
                            : "Preview Disposition Markdown"}
                        </Button>
                      </Inline>
                    </Inline>
                    <Text>
                      Cryptographically bound DVP&amp;R disposition summary citing RFC 8785 snapshot
                      SHA-256, monotonic approvalGeneration, slice × obligation verdicts, and
                      pinned Jira evidence hashes.
                    </Text>
                    {showAuditMarkdown ? (
                      <CodeBlock language="markdown" text={view.releaseAssuranceMarkdown} />
                    ) : null}
                  </Stack>
                </Box>
              ) : null}
            </Stack>
          </TabPanel>

          {/* TAB 5: LIVE JIRA EVIDENCE HASH MONITOR & DIAGNOSTICS */}
          <TabPanel>
            <Stack space="space.200">
              <SectionMessage
                appearance="information"
                title="Live Jira Evidence Content-Pinning & Tamper Lab"
              >
                <Stack space="space.100">
                  <Text>
                    LineLock never trusts issue timestamps or Done status alone. Edit the summary or
                    description of any linked qualification work item below in Jira, then click
                    &quot;Refresh Live State&quot; above to watch SHA-256 content drift invalidate
                    release readiness immediately. After legitimate test updates are reviewed in
                    Done status, re-pinning increments approvalGeneration and forces fresh signoff.
                  </Text>
                  <Inline space="space.100" shouldWrap>
                    <LoadingButton
                      appearance="primary"
                      isLoading={busyAction === "repin-ev"}
                      onClick={handleRepinLiveEvidence}
                    >
                      Re-Pin Live Done Jira Hashes (CAS + Gen Increment)
                    </LoadingButton>
                  </Inline>
                </Stack>
              </SectionMessage>

              <DynamicTable
                caption="Pinned vs. Live Jira Verification Work Items"
                head={{
                  cells: [
                    { key: "ticket", content: "Jira Ticket" },
                    { key: "obl", content: "Obligation & Variant" },
                    { key: "status", content: "Live Status" },
                    { key: "hashes", content: "Pinned vs. Live SHA-256" },
                    { key: "integrity", content: "Integrity" }
                  ]
                }}
                rows={evidenceIntegrity.map((row) => ({
                  key: row.evidenceId,
                  cells: [
                    {
                      key: "ticket",
                      content: (
                        <Stack space="space.050">
                          <Code>{row.jiraIssueKey}</Code>
                          <Text>{`id=${row.jiraIssueId}`}</Text>
                        </Stack>
                      )
                    },
                    {
                      key: "obl",
                      content: (
                        <Stack space="space.050">
                          <Code>{row.obligationCode}</Code>
                          <Text>{row.testedVariantId}</Text>
                        </Stack>
                      )
                    },
                    {
                      key: "status",
                      content: (
                        <Lozenge
                          appearance={row.statusIsDone ? "success" : "moved"}
                          isBold
                          maxWidth={340}
                        >
                          {row.liveStatusCategoryKey ?? "UNREACHABLE"}
                        </Lozenge>
                      )
                    },
                    {
                      key: "hashes",
                      content: (
                        <Stack space="space.050">
                          <Code>{`Pin : ${row.pinnedIssueStateHash.slice(0, 14)}...`}</Code>
                          <Code>
                            {`Live: ${row.liveIssueStateHash ? `${row.liveIssueStateHash.slice(0, 14)}...` : "MISSING"}`}
                          </Code>
                        </Stack>
                      )
                    },
                    {
                      key: "integrity",
                      content: (
                        <Lozenge
                          appearance={row.statusIsDone && row.hashMatches ? "success" : "removed"}
                          isBold
                          maxWidth={340}
                        >
                          {row.statusIsDone && row.hashMatches ? "PIN VERIFIED" : "DRIFT / MISSING"}
                        </Lozenge>
                      )
                    }
                  ]
                }))}
              />

              <Box xcss={cardBoxStyle}>
                <Stack space="space.150">
                  <Heading size="xsmall">Platform &amp; Forge SQL Diagnostics</Heading>
                  <ButtonGroup>
                    <LoadingButton isLoading={busyAction === "probe"} onClick={handleProbe}>
                      Run Live Jira Connectivity Probe
                    </LoadingButton>
                    <LoadingButton
                      isLoading={busyAction === "recover-sql"}
                      onClick={handleRecoverSql}
                    >
                      Verify SQL Schema Migrations
                    </LoadingButton>
                  </ButtonGroup>

                  {probe ? (
                    <CodeBlock language="json" text={JSON.stringify(probe, null, 2)} />
                  ) : null}
                </Stack>
              </Box>
            </Stack>
          </TabPanel>
        </Tabs>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <LineLockAssuranceCockpit />
  </React.StrictMode>
);
