import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  BarChart,
  Box,
  Code,
  DonutChart,
  DynamicTable,
  Heading,
  Inline,
  LoadingButton,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Select,
  Stack,
  Tag,
  Text,
  xcss
} from "@forge/react";
import { invoke } from "@forge/bridge";
import type { EcoGateState } from "../core/types";
import type { ProjectFleetOverview, ProjectGovernanceConfig } from "../forge/ports";

function unwrapInvoke<T>(raw: T | { readonly body: T }): T {
  if (raw && typeof raw === "object" && "body" in raw) {
    return (raw as { readonly body: T }).body;
  }
  return raw;
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

function inferDomainBadge(familyId: string): {
  readonly label: string;
  readonly color: "blue" | "teal" | "purple";
} {
  if (familyId.startsWith("PULSEGUARD")) {
    return { label: "MedTech IEC 60601", color: "teal" };
  }
  if (familyId.startsWith("AEGIS")) {
    return { label: "Aerospace DO-160G", color: "purple" };
  }
  return { label: "Automotive EV ISO 26262", color: "blue" };
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

const chartCardStyle = xcss({
  backgroundColor: "color.background.neutral",
  borderColor: "color.border",
  borderWidth: "border.width",
  borderStyle: "solid",
  borderRadius: "radius.medium",
  padding: "space.200"
});

const LineLockFleetAssurancePage: React.FC = () => {
  const [overview, setOverview] = useState<ProjectFleetOverview | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [governanceSetup, setGovernanceSetup] = useState<{
    readonly config: ProjectGovernanceConfig | null;
    readonly issueTypes: readonly { readonly id: string; readonly name: string }[];
  } | null>(null);
  const [selectedGovernedType, setSelectedGovernedType] = useState<string>("");

  const loadFleet = async (): Promise<void> => {
    setBusyAction("refresh");
    setErrorMsg(null);
    try {
      const res = unwrapInvoke(await invoke<ProjectFleetOverview>("getProjectFleetOverview"));
      setOverview(res);
      try {
        const setup = unwrapInvoke(await invoke<{
          readonly config: ProjectGovernanceConfig | null;
          readonly issueTypes: readonly { readonly id: string; readonly name: string }[];
        }>("getProjectGovernanceSetup"));
        setGovernanceSetup(setup);
        if (setup.config?.governedIssueTypeIds[0]) {
          setSelectedGovernedType(setup.config.governedIssueTypeIds[0]);
        }
      } catch {
        // Fleet visibility is independent of optional admin setup access.
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRecoverSql = async (): Promise<void> => {
    setBusyAction("recover-sql");
    setErrorMsg(null);
    try {
      await invoke("triggerProvisioningRecovery");
      await loadFleet();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setBusyAction(null);
    }
  };

  const saveGovernedIssueType = async (): Promise<void> => {
    setBusyAction("save-governance");
    setErrorMsg(null);
    try {
      if (!selectedGovernedType) {
        throw new Error("Select a dedicated Engineering Change Order issue type.");
      }
      const config = unwrapInvoke(await invoke<ProjectGovernanceConfig>(
        "setProjectGovernanceIssueTypes",
        { issueTypeIds: [selectedGovernedType] }
      ));
      setGovernanceSetup((previous) => previous
        ? { ...previous, config }
        : previous
      );
      await loadFleet();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    void loadFleet();
  }, []);

  const vd = overview?.verdictDistribution ?? {
    supportedAsTested: 0,
    supportedByRule: 0,
    invalidated: 0,
    indeterminate: 0
  };
  const bc = overview?.baselineComparisonTotals ?? {
    b0Supported: 0,
    b1Supported: 0,
    b2Supported: 0,
    linelockSupported: 0,
    totalSliceObligations: 0
  };

  const donutData = [
    {
      verdict: "Supported As Tested",
      count: vd.supportedAsTested,
      category: "Supported As Tested"
    },
    {
      verdict: "Supported By K3 Rule",
      count: vd.supportedByRule,
      category: "Supported By K3 Rule"
    },
    {
      verdict: "Invalidated (FALSE)",
      count: vd.invalidated,
      category: "Invalidated (FALSE)"
    },
    {
      verdict: "Indeterminate / Uncovered",
      count: vd.indeterminate,
      category: "Indeterminate / Uncovered"
    }
  ].filter((item) => item.count > 0);

  const baselineBarData = [
    {
      method: "B0 Timestamp",
      supported: bc.b0Supported,
      baseline: "B0 Timestamp Freshness"
    },
    {
      method: "B1 ALM Suspect",
      supported: bc.b1Supported,
      baseline: "B1 Untyped ALM Links"
    },
    {
      method: "B2 PLM Env",
      supported: bc.b2Supported,
      baseline: "B2 PLM Version + Env"
    },
    {
      method: "LineLock K3",
      supported: bc.linelockSupported,
      baseline: "LineLock Strong Kleene K3"
    }
  ];

  return (
    <Stack space="space.250">
      {/* Executive Space Header */}
      <Box xcss={cardBoxStyle}>
        <Stack space="space.150">
          <Inline spread="space-between" alignBlock="center" space="space.150" shouldWrap>
            <Stack space="space.050">
              <Heading size="medium">
                LineLock Fleet Assurance — Space-Wide Engineering Evidence Portfolio
              </Heading>
              <Text>
                Live effectivity-scoped Strong Kleene K3 verification, RFC 8785 SHA-256 Jira
                evidence content-pinning, and multi-industry release gate governance across all
                initialized Engineering Change Orders in this space.
              </Text>
            </Stack>

            <LoadingButton
              appearance="primary"
              isLoading={busyAction === "refresh"}
              onClick={() => void loadFleet()}
            >
              Refresh Live Fleet State
            </LoadingButton>
          </Inline>

          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Tag text={`Space: ${overview?.projectKey ?? "..."}`} color="blue" />
            <Tag
              text={`SQL: ${overview?.provisioning.state ?? "CHECKING"}`}
              color="teal"
            />
            <Tag text="Forge-native · no external egress" color="blue" />
            <Tag text="Atlassian Rovo Analyst Ready" color="green" />
            {overview ? (
              <Code>{`Total Slice × Obligations Audited: ${bc.totalSliceObligations}`}</Code>
            ) : null}
          </Inline>
        </Stack>
      </Box>

      {governanceSetup ? (
        <Box xcss={cardBoxStyle}>
          <Stack space="space.100">
            <Heading size="small">Release gate issue-type policy</Heading>
            <Text>
              Restrict LineLock's mandatory release gate to a dedicated Jira Engineering
              Change Order type. Ordinary Tasks and qualification test tickets remain
              outside the gate. Only a Jira project administrator may change this policy.
            </Text>
            <Text>
              {governanceSetup.config
                ? `Configured: ${governanceSetup.config.governedIssueTypeIds.join(", ")} (issue-type IDs). Changed by ${governanceSetup.config.updatedByAccountId}.`
                : "Not configured: compatibility type-name matching is active. Set a dedicated ECO type before production use."}
            </Text>
            <Inline space="space.100" alignBlock="end" shouldWrap>
              <Select
                options={governanceSetup.issueTypes.filter(
                  (item) => !["task", "story", "bug", "sub-task", "subtask"].includes(
                    item.name.trim().toLowerCase()
                  )
                ).map((item) => ({ label: item.name, value: item.id }))}
                value={governanceSetup.issueTypes
                  .filter((item) => item.id === selectedGovernedType)
                  .map((item) => ({ label: item.name, value: item.id }))[0] ?? null}
                onChange={(option: { value?: string } | null) => {
                  setSelectedGovernedType(option?.value ?? "");
                }}
              />
              <LoadingButton
                appearance="primary"
                isLoading={busyAction === "save-governance"}
                onClick={() => void saveGovernedIssueType()}
              >
                Save Governed ECO Type
              </LoadingButton>
            </Inline>
          </Stack>
        </Box>
      ) : null}

      {errorMsg ? (
        <SectionMessage appearance="error" title="Fleet Telemetry Error">
          <Text>{errorMsg}</Text>
        </SectionMessage>
      ) : null}

      {overview && overview.provisioning.state !== "READY" ? (
        <SectionMessage
          appearance="warning"
          title={`Forge SQL Storage: ${overview.provisioning.state}`}
        >
          <Stack space="space.100">
            <Text>
              {overview.provisioning.lastErrorMessage ??
                "Forge SQL schema migrations have not completed yet. Workflow transitions fail closed until READY."}
            </Text>
            <Inline space="space.100">
              <LoadingButton
                appearance="primary"
                isLoading={busyAction === "recover-sql"}
                onClick={() => void handleRecoverSql()}
              >
                Run Idempotent SQL Migration Recovery
              </LoadingButton>
            </Inline>
          </Stack>
        </SectionMessage>
      ) : null}

      {/* Fleet KPI Summary Strip */}
      {overview && overview.provisioning.state === "READY" ? (
        <Inline space="space.150" shouldWrap>
          <Box xcss={metricCardStyle}>
            <Stack space="space.050">
              <Text>Tracked ECO Workspaces</Text>
              <Heading size="medium">{String(overview.totalEcos)}</Heading>
            </Stack>
          </Box>
          <Box xcss={metricCardStyle}>
            <Stack space="space.050">
              <Text>Release Verified (Done)</Text>
              <Heading size="medium">{String(overview.verifiedReleasedCount)}</Heading>
            </Stack>
          </Box>
          <Box xcss={metricCardStyle}>
            <Stack space="space.050">
              <Text>Ready / Awaiting Signoff</Text>
              <Heading size="medium">
                {`${overview.readyCount} / ${overview.awaitingSignoffCount}`}
              </Heading>
            </Stack>
          </Box>
          <Box xcss={metricCardStyle}>
            <Stack space="space.050">
              <Text>Blocked / Invalidated</Text>
              <Heading size="medium">{String(overview.blockedCount)}</Heading>
            </Stack>
          </Box>
          <Box xcss={metricCardStyle}>
            <Stack space="space.050">
              <Text>SHA-256 Evidence Drift Alerts</Text>
              <Heading size="medium">{String(overview.driftAlertCount)}</Heading>
            </Stack>
          </Box>
        </Inline>
      ) : null}

      {/* Empty-State Guidance */}
      {overview && overview.provisioning.state === "READY" && overview.totalEcos === 0 ? (
        <SectionMessage
          appearance="information"
          title="No Engineering Change Orders Initialized in This Space Yet"
        >
          <Text>
            Open any Jira work item in this space (for example ECO-1), launch the LineLock
            Assurance Cockpit panel, choose an industry domain template (Automotive EV Powertrain,
            MedTech Class III IEC 60601 Infusion Pump, or Aerospace DO-160G Flight Actuator), and
            click &quot;Provision 6 Live Jira Qualification Tests&quot; to populate this fleet
            portfolio.
          </Text>
        </SectionMessage>
      ) : null}

      {/* Native UI Kit 2 Visual Analytics */}
      {overview && overview.totalEcos > 0 && bc.totalSliceObligations > 0 ? (
        <Inline space="space.200" shouldWrap>
          <Box xcss={chartCardStyle}>
            <DonutChart
              title="Fleet Slice × Obligation Verdicts"
              subtitle="Strong Kleene K3 assurance breakdown across all effective serial intervals"
              data={donutData}
              labelAccessor="verdict"
              valueAccessor="count"
              colorAccessor="category"
              showMarkLabels={true}
              height={320}
              width={440}
            />
          </Box>
          <Box xcss={chartCardStyle}>
            <BarChart
              title="LineLock vs. PLM/ALM Baselines"
              subtitle={`Supported obligations out of ${bc.totalSliceObligations} total slice × obligations`}
              data={baselineBarData}
              xAccessor="method"
              yAccessor="supported"
              colorAccessor="baseline"
              height={320}
              width={460}
            />
          </Box>
        </Inline>
      ) : null}

      {/* Multi-ECO Portfolio Matrix */}
      {overview && overview.ecos.length > 0 ? (
        <Box xcss={cardBoxStyle}>
          <DynamicTable
            caption="Initialized Engineering Change Order (ECO) Assurance Portfolio"
            head={{
              cells: [
                { key: "eco", content: "ECO & Hardware Family" },
                { key: "gate", content: "Release Gate & Workflow" },
                { key: "coverage", content: "Slice × Obligation Coverage" },
                { key: "pins", content: "Jira SHA-256 Pins" },
                { key: "crypto", content: "Snapshot & CAS Governance" }
              ]
            }}
            rows={overview.ecos.map((row) => {
              const badge = inferDomainBadge(row.familyId);
              const coverageRatio =
                row.totalObligations > 0 ? row.supportedObligations / row.totalObligations : 0;
              const allPinned =
                row.totalEvidenceCount > 0 &&
                row.evidencePinHealthyCount === row.totalEvidenceCount;

              return {
                key: row.ecoIssueId,
                cells: [
                  {
                    key: "eco",
                    content: (
                      <Stack space="space.050">
                        <Inline space="space.100" alignBlock="center">
                          <Code>{row.ecoIssueKey}</Code>
                          <Tag text={badge.label} color={badge.color} />
                        </Inline>
                        <Text>{row.familyId}</Text>
                      </Stack>
                    )
                  },
                  {
                    key: "gate",
                    content: (
                      <Stack space="space.050">
                        <Lozenge appearance={gateAppearance(row.gateState)} isBold maxWidth={340}>
                          {gateShortLabel(row.gateState)}
                        </Lozenge>
                        <Lozenge
                          appearance={row.transitionAllowed ? "success" : "removed"}
                          isBold
                          maxWidth={340}
                        >
                          {row.transitionAllowed ? "RELEASE ALLOWED" : "WORKFLOW LOCKED"}
                        </Lozenge>
                      </Stack>
                    )
                  },
                  {
                    key: "coverage",
                    content: (
                      <Stack space="space.075">
                        <ProgressBar
                          ariaLabel={`Coverage for ${row.ecoIssueKey}`}
                          appearance={coverageRatio >= 1 ? "success" : "default"}
                          value={coverageRatio}
                        />
                        <Text>
                          {`${row.supportedObligations}/${row.totalObligations} supported across ${row.sliceCount} serial slice(s)`}
                        </Text>
                      </Stack>
                    )
                  },
                  {
                    key: "pins",
                    content: (
                      <Lozenge appearance={allPinned ? "success" : "removed"} isBold maxWidth={340}>
                        {`${row.evidencePinHealthyCount}/${row.totalEvidenceCount} PINNED`}
                      </Lozenge>
                    )
                  },
                  {
                    key: "crypto",
                    content: (
                      <Stack space="space.050">
                        <Code>{`SHA-256: ${row.snapshotSha256.slice(0, 12)}...`}</Code>
                        <Code>{`Gen ${row.approvalGeneration} · CAS Rev ${row.revisionSeq} · ${row.policyId} v${row.policyVersion}`}</Code>
                      </Stack>
                    )
                  }
                ]
              };
            })}
          />
        </Box>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <LineLockFleetAssurancePage />
  </React.StrictMode>
);
