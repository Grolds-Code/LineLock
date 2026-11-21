import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  Button,
  ButtonGroup,
  CodeBlock,
  SectionMessage,
  Stack,
  Text
} from "@forge/react";
import { invoke } from "@forge/bridge";
import type { ConnectivityProbeResult, EcoWorkspaceView } from "../forge/ports.js";

function unwrapInvoke<T>(raw: T | { readonly body: T }): T {
  if (raw && typeof raw === "object" && "body" in raw) {
    return (raw as { readonly body: T }).body;
  }
  return raw;
}

/**
 * Minimal vertical-slice diagnostic harness (intentionally unstyled; no dashboard chrome).
 * Exposes live Jira REST connectivity check, SQL provisioning recovery, Helios scenario
 * seeding, serial-scoped Rev C substitution, and role attestation.
 */
const VerticalSliceHarness: React.FC = () => {
  const [probe, setProbe] = useState<ConnectivityProbeResult | null>(null);
  const [view, setView] = useState<EcoWorkspaceView | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refreshView = async (): Promise<void> => {
    try {
      setErrorMsg(null);
      const res = unwrapInvoke(await invoke<EcoWorkspaceView>("getWorkspaceView"));
      setView(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refreshView();
  }, []);

  const handleProbe = async (): Promise<void> => {
    try {
      setErrorMsg(null);
      const res = unwrapInvoke(
        await invoke<{
          readonly connectivity: ConnectivityProbeResult;
          readonly provisioning: EcoWorkspaceView["provisioning"];
        }>("probeConnectivity")
      );
      setProbe(res.connectivity);
      await refreshView();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRecoverSql = async (): Promise<void> => {
    try {
      setErrorMsg(null);
      await invoke("triggerProvisioningRecovery");
      await refreshView();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSeed = async (): Promise<void> => {
    try {
      setErrorMsg(null);
      const res = unwrapInvoke(await invoke<EcoWorkspaceView>("seedHeliosWorkspace"));
      setView(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleProposeRevC = async (only400V: boolean): Promise<void> => {
    if (!view?.workspace) return;
    try {
      setErrorMsg(null);
      await invoke("proposeCapRevCFrom5000", {
        expectedRevisionSeq: view.workspace.revisionSeq,
        targetVariants: only400V ? ["VAR_400V"] : "ALL"
      });
      await refreshView();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevert = async (): Promise<void> => {
    if (!view?.workspace) return;
    try {
      setErrorMsg(null);
      await invoke("revertToBaselineBom", {
        expectedRevisionSeq: view.workspace.revisionSeq
      });
      await refreshView();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Stack space="space.150">
      <Text>LineLock Vertical Slice — Jira &amp; Forge SQL Diagnostic Harness</Text>
      {errorMsg ? (
        <SectionMessage appearance="error" title="Operation Error">
          <Text>{errorMsg}</Text>
        </SectionMessage>
      ) : null}

      <ButtonGroup>
        <Button onClick={handleProbe}>Run Jira Connectivity Probe</Button>
        <Button onClick={handleRecoverSql}>Run SQL Schema Migration</Button>
        <Button onClick={handleSeed}>Seed Helios Pack ECO</Button>
        <Button onClick={() => handleProposeRevC(false)}>Propose Cap Rev C (ALL, SN&gt;=5000)</Button>
        <Button onClick={() => handleProposeRevC(true)}>Propose Cap Rev C (400V Only)</Button>
        <Button onClick={handleRevert}>Revert to Baseline BOM</Button>
      </ButtonGroup>

      {probe ? (
        <CodeBlock language="json" text={JSON.stringify(probe, null, 2)} />
      ) : null}

      {view ? (
        <CodeBlock
          language="json"
          text={JSON.stringify(
            {
              provisioning: view.provisioning,
              revisionSeq: view.workspace?.revisionSeq ?? null,
              approvalGeneration: view.workspace?.eco.approvalGeneration ?? null,
              gateState: view.evaluation?.gateState ?? null,
              transitionAllowed: view.evaluation?.transitionAllowed ?? null,
              snapshotSha256: view.evaluation?.snapshotSha256 ?? null,
              blockingReasons: view.evaluation?.blockingReasons ?? []
            },
            null,
            2
          )}
        />
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <VerticalSliceHarness />
  </React.StrictMode>
);
