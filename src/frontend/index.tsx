import React, { useEffect, useState } from "react";
import ForgeReconciler, {
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
  SectionMessage,
  Select,
  Stack,
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
  PredicateTraceNode,
  SerialInterval,
  SliceObligationEvaluation,
  SliceObligationStatus,
  TruthValue
} from "../core/types";
import type {
  ConnectivityProbeResult,
  CounterfactualRequest,
  CounterfactualSimulationResult,
  EcoWorkspaceView,
  GovernancePolicyMode,
  ScenarioPresetId
} from "../forge/ports";

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

  // Selected row in Assurance Matrix for Strong Kleene K3 Proof inspection
  const [selectedSliceOblKey, setSelectedSliceOblKey] = useState<string | null>(null);

  // Counterfactual Simulator state
  const [cfKind, setCfKind] = useState<CounterfactualRequest["kind"]>("CAP_REV_C_CUTOVER");
  const [cfVariantScope, setCfVariantScope] = useState<"ALL" | "VAR_400V" | "VAR_800V">("VAR_400V");
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

  const refreshView = async (): Promise<void> => {
    try {
      const res = unwrapInvoke(await invoke<EcoWorkspaceView>("getWorkspaceView"));
      setView(res);
      if (res.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(res.evaluation.attestationSummary.missingRoles[0]);
      }
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
      const next = unwrapInvoke(await invoke<EcoWorkspaceView>("provisionLiveJiraWorkspace"));
      setView(next);
      setCfResult(null);
      if (next.evaluation?.attestationSummary.missingRoles[0]) {
        setSelectedRole(next.evaluation.attestationSummary.missingRoles[0]);
      }
      setStatusNotice(
        "Provisioned 6 live Jira qualification work items in Done status and pinned their SHA-256 content hashes in Forge SQL."
      );
    });

  const handleSeedOffline = (): Promise<void> =>
    runAction("seed-offline", async () => {
      const next = unwrapInvoke(await invoke<EcoWorkspaceView>("seedHeliosWorkspace"));
      setView(next);
      setCfResult(null);
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

      const request: CounterfactualRequest =
        cfKind === "AMBIENT_ENVELOPE_SHIFT"
          ? {
              kind: "AMBIENT_ENVELOPE_SHIFT",
              variantId: cfVariantScope === "VAR_800V" ? "VAR_800V" : "VAR_400V",
              minAmbientC: Number.parseInt(cfMinAmbient, 10) || -20,
              maxAmbientC: Number.parseInt(cfMaxAmbient, 10) || 58
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

  const supportedCount = evaluation
    ? evaluation.sliceObligations.filter(
        (s) => s.status === "SUPPORTED_AS_TESTED" || s.status === "SUPPORTED_BY_APPROVED_RULE"
      ).length
    : 0;
  const blockedCount = evaluation ? evaluation.sliceObligations.length - supportedCount : 0;
  const minRetestCount = evaluation
    ? evaluation.remediationPlans.reduce((acc, p) => acc + p.selectedActions.length, 0)
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

            <Inline space="space.100" shouldWrap>
              <LoadingButton
                isLoading={busyAction === "refresh"}
                onClick={() => runAction("refresh", refreshView)}
              >
                Refresh Live State
              </LoadingButton>
              {workspace ? (
                <LoadingButton
                  isLoading={busyAction === "provision-live"}
                  onClick={handleProvisionLiveJira}
                >
                  Re-Provision 6 Live Jira Tests
                </LoadingButton>
              ) : null}
            </Inline>
          </Inline>

          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Tag text={`SQL: ${view?.provisioning.state ?? "CHECKING"}`} color="teal" />
            <Tag text="Runs on Atlassian" color="blue" />
            {workspace && evaluation ? (
              <>
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

      {/* Unseeded Onboarding View */}
      {view?.provisioning.state === "READY" && !workspace ? (
        <Box xcss={cardBoxStyle}>
          <Stack space="space.150">
            <Heading size="small">Initialize Helios EV Traction Battery Pack ECO</Heading>
            <Text>
              Provision 6 real Jira qualification work items (400V &amp; 800V HV Thermal Ripple,
              12V Conducted EMC, and IP67 Enclosure Ingress), transition them to Done, link them to
              this ECO, and pin their live RFC 8785 SHA-256 content hashes in Forge SQL.
            </Text>
            <Inline space="space.100" shouldWrap>
              <LoadingButton
                appearance="primary"
                isLoading={busyAction === "provision-live"}
                onClick={handleProvisionLiveJira}
              >
                Provision Helios EV Pack + 6 Live Jira Tests (Recommended)
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

      {/* Main 4-Tab Engineering Cockpit */}
      {workspace && evaluation ? (
        <Tabs id="linelock-cockpit-tabs">
          <TabList>
            <Tab>Assurance Matrix &amp; K3 Proof</Tab>
            <Tab>Counterfactual &amp; Remediation</Tab>
            <Tab>Governance &amp; ABA Signoff</Tab>
            <Tab>Jira Evidence &amp; Diagnostics</Tab>
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

              <Box xcss={cardBoxStyle}>
                <Stack space="space.100">
                  <Heading size="xsmall">Commit Engineering Change Scenario (CAS + Gen Increment)</Heading>
                  <Inline space="space.100" shouldWrap>
                    <LoadingButton
                      isLoading={busyAction === "preset:CAP_REV_C_ALL_5000"}
                      onClick={() =>
                        handleApplyPreset(
                          "CAP_REV_C_ALL_5000",
                          "Cap Rev C on ALL Variants (SN >= 5000)"
                        )
                      }
                    >
                      Propose Cap Rev C (ALL, SN&gt;=5000)
                    </LoadingButton>
                    <LoadingButton
                      appearance="primary"
                      isLoading={busyAction === "preset:CAP_REV_C_400V_5000"}
                      onClick={() =>
                        handleApplyPreset(
                          "CAP_REV_C_400V_5000",
                          "Scoped Cap Rev C on 400V Only (SN >= 5000)"
                        )
                      }
                    >
                      Scope Cap Rev C to 400V Only (SN&gt;=5000)
                    </LoadingButton>
                    <LoadingButton
                      isLoading={busyAction === "preset:COLD_SOAK_MINUS_40C"}
                      onClick={() =>
                        handleApplyPreset(
                          "COLD_SOAK_MINUS_40C",
                          "Arctic Cold-Soak -40C Envelope Shift"
                        )
                      }
                    >
                      Test -40C Cold-Soak Regression
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
                            label: "HV Cap -> CAP-1210@C (630V X7R)",
                            value: "CAP_REV_C_CUTOVER"
                          },
                          {
                            label: "HV Cap -> CAP-1210@D_DRAFT (Unapproved Sample)",
                            value: "CAP_REV_D_DRAFT_CUTOVER"
                          },
                          {
                            label: "Gate Driver -> DRV-ISO@B (19ns Uncovered Slot)",
                            value: "GATE_DRIVER_REV_B_CUTOVER"
                          },
                          {
                            label: "Enclosure Gasket -> SEAL-EPDM@B (Excluded HV/EMC)",
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
                              ? "HV Cap -> CAP-1210@C (630V X7R)"
                              : cfKind === "CAP_REV_D_DRAFT_CUTOVER"
                                ? "HV Cap -> CAP-1210@D_DRAFT (Unapproved Sample)"
                                : cfKind === "GATE_DRIVER_REV_B_CUTOVER"
                                  ? "Gate Driver -> DRV-ISO@B (19ns Uncovered Slot)"
                                  : cfKind === "SEAL_REV_B_CUTOVER"
                                    ? "Enclosure Gasket -> SEAL-EPDM@B (Excluded HV/EMC)"
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
                        options={[
                          { label: "VAR_400V Commuter Pack Only", value: "VAR_400V" },
                          { label: "ALL Variants (400V + 800V)", value: "ALL" },
                          { label: "VAR_800V HyperCharge Only", value: "VAR_800V" }
                        ]}
                        value={{
                          label:
                            cfVariantScope === "VAR_400V"
                              ? "VAR_400V Commuter Pack Only"
                              : cfVariantScope === "ALL"
                                ? "ALL Variants (400V + 800V)"
                                : "VAR_800V HyperCharge Only",
                          value: cfVariantScope
                        }}
                        onChange={(opt: { value?: string } | null) => {
                          const v = opt?.value;
                          if (v === "ALL" || v === "VAR_400V" || v === "VAR_800V") {
                            setCfVariantScope(v);
                          }
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

                        {cfResult.baselineComparison ? (
                          <Stack space="space.075">
                            <Heading size="xsmall">
                              Simulated Industry Baseline Comparison (Why Traditional PLM/ALM Fails)
                            </Heading>
                            <Inline space="space.100" shouldWrap>
                              <Code>
                                {`B0 (Timestamp Freshness): ${
                                  cfResult.baselineComparison.b0.filter(
                                    (x) => x.verdict === "SUPPORTED"
                                  ).length
                                }/${cfResult.baselineComparison.b0.length} supported`}
                              </Code>
                              <Code>
                                {`B1 (Untyped ALM Suspect Graph): ${
                                  cfResult.baselineComparison.b1.filter(
                                    (x) => x.verdict === "SUPPORTED"
                                  ).length
                                }/${cfResult.baselineComparison.b1.length} supported`}
                              </Code>
                              <Code>
                                {`B2 (PLM Version + Std Envelope): ${
                                  cfResult.baselineComparison.b2.filter(
                                    (x) => x.verdict === "SUPPORTED"
                                  ).length
                                }/${cfResult.baselineComparison.b2.length} supported`}
                              </Code>
                              <Code>
                                {`LineLock (Strong Kleene K3): ${cfResult.delta.simulatedSupportedCount}/${cfResult.simulatedEvaluation.sliceObligations.length} supported`}
                              </Code>
                            </Inline>
                          </Stack>
                        ) : null}
                      </Stack>
                    </Box>
                  ) : null}
                </Stack>
              </Box>

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

          {/* TAB 3: GOVERNANCE, SEPARATION OF DUTIES & ABA SIGNOFF */}
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
                      isBold maxWidth={340}
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
                    <Text>No valid attestations recorded for the current snapshot &amp; generation.</Text>
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

          {/* TAB 4: LIVE JIRA EVIDENCE HASH MONITOR & DIAGNOSTICS */}
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
                        <Lozenge appearance={row.statusIsDone ? "success" : "moved"} isBold maxWidth={340}>
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
