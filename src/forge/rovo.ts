import type { JiraPlatformGateway } from "./ports";
import type { LineLockService } from "./service";

/**
 * Strictly READ-ONLY Rovo Agent Action Handlers (`actionVerb: GET`).
 *
 * Trust-Boundary Invariant:
 * AI / Rovo never approves an ECO, never writes to Forge SQL, and never overrides
 * `verifyEngineeringChange`. Every answer cites deterministic kernel outputs.
 */
export function createRovoActionHandlers(params: {
  readonly service: LineLockService;
  readonly jira: JiraPlatformGateway;
}) {
  const { service, jira } = params;

  const resolveIssue = async (rawIssueKeyOrId: unknown) => {
    const key = typeof rawIssueKeyOrId === "string" ? rawIssueKeyOrId.trim() : "";
    if (!key) {
      throw new Error("Input `issueKey` (e.g. 'ECO-1') is required.");
    }
    return jira.fetchLiveIssueByKeyOrId(key);
  };

  return {
    async inspectEcoAssurance(payload: { readonly issueKey?: string }) {
      const issue = await resolveIssue(payload?.issueKey);
      const view = await service.getWorkspaceView({
        projectKey: issue.projectKey,
        ecoIssueId: issue.issueId
      });

      if (!view.workspace || !view.evaluation) {
        return {
          authority: "READ_ONLY_DETERMINISTIC_KERNEL",
          issueKey: issue.issueKey,
          provisioningState: view.provisioning.state,
          initialized: false,
          message: `No LineLock verification workspace is initialized yet on ${issue.issueKey}. Open the LineLock panel on ${issue.issueKey} and click 'Provision Helios EV Pack + 6 Live Jira Tests'.`
        };
      }

      return {
        authority: "READ_ONLY_DETERMINISTIC_KERNEL",
        issueKey: issue.issueKey,
        snapshotSha256: view.evaluation.snapshotSha256,
        approvalGeneration: view.evaluation.approvalGeneration,
        policyVersion: view.evaluation.policyVersion,
        gateState: view.evaluation.gateState,
        transitionAllowed: view.evaluation.transitionAllowed,
        blockingReasons: view.evaluation.blockingReasons,
        sliceObligations: view.evaluation.sliceObligations.map((so) => ({
          sliceId: so.sliceId,
          obligationCode: so.obligationCode,
          status: so.status,
          supportingEvidenceId: so.supportingEvidenceId,
          appliedCarryForwardRuleId: so.appliedCarryForwardRuleId,
          explanation: so.explanation,
          changedGovernedSlots: so.changedGovernedSlots,
          changedExcludedSlots: so.changedExcludedSlots,
          validityTruthValue: so.validityTrace?.value ?? null,
          validityReason: so.validityTrace?.reason ?? null
        })),
        remediationPlans: view.evaluation.remediationPlans,
        attestationSummary: view.evaluation.attestationSummary,
        evidenceIntegrity: view.evidenceIntegrity
      };
    },

    async simulateSerialCutover(payload: {
      readonly issueKey?: string;
      readonly variantScope?: string;
      readonly serialFrom?: number;
      readonly serialTo?: number;
    }) {
      const issue = await resolveIssue(payload?.issueKey);
      const rawScope = (payload?.variantScope ?? "VAR_400V").trim().toUpperCase();
      const targetVariants: "ALL" | readonly string[] =
        rawScope === "ALL"
          ? "ALL"
          : rawScope === "VAR_800V"
            ? ["VAR_800V"]
            : ["VAR_400V"];

      const serialFrom =
        typeof payload?.serialFrom === "number" && Number.isFinite(payload.serialFrom)
          ? Math.max(1000, Math.trunc(payload.serialFrom))
          : 5000;

      const serialTo =
        typeof payload?.serialTo === "number" &&
        Number.isFinite(payload.serialTo) &&
        Math.trunc(payload.serialTo) > serialFrom
          ? Math.trunc(payload.serialTo)
          : null;

      const sim = await service.simulateCounterfactual({
        projectKey: issue.projectKey,
        ecoIssueId: issue.issueId,
        request: {
          kind: "CAP_REV_C_CUTOVER",
          targetVariants,
          serialFrom,
          serialTo
        },
        includeBaselines: true
      });

      return {
        authority: "READ_ONLY_COUNTERFACTUAL_SIMULATION",
        mutatedStorage: false,
        issueKey: issue.issueKey,
        simulatedParameters: {
          componentSubstitution: "HV_INV/DC_LINK_CAP_C14 -> CAP-1210@C (630V X7R 10mOhm)",
          targetVariants,
          serialFrom,
          serialTo
        },
        delta: sim.delta,
        simulatedBlockingReasons: sim.simulatedEvaluation.blockingReasons,
        simulatedRemediationPlans: sim.simulatedEvaluation.remediationPlans,
        simulatedSliceStatuses: sim.simulatedEvaluation.sliceObligations.map((s) => ({
          sliceId: s.sliceId,
          obligationCode: s.obligationCode,
          status: s.status,
          rule: s.appliedCarryForwardRuleId,
          explanation: s.explanation
        }))
      };
    },

    async compareBaselines(payload: { readonly issueKey?: string }) {
      const issue = await resolveIssue(payload?.issueKey);
      const cmp = await service.compareCurrentEcoAgainstBaselines({
        projectKey: issue.projectKey,
        ecoIssueId: issue.issueId
      });

      const discrepancies = cmp.linelock.sliceObligations
        .map((ll) => {
          const llSupported =
            ll.status === "SUPPORTED_AS_TESTED" || ll.status === "SUPPORTED_BY_APPROVED_RULE";
          const b0Verdict =
            cmp.b0.find((r) => r.sliceId === ll.sliceId && r.obligationId === ll.obligationId)
              ?.verdict === "SUPPORTED";
          const b1Verdict =
            cmp.b1.find((r) => r.sliceId === ll.sliceId && r.obligationId === ll.obligationId)
              ?.verdict === "SUPPORTED";
          const b2Verdict =
            cmp.b2.find((r) => r.sliceId === ll.sliceId && r.obligationId === ll.obligationId)
              ?.verdict === "SUPPORTED";

          return {
            sliceId: ll.sliceId,
            obligationCode: ll.obligationCode,
            lineLockStatus: ll.status,
            lineLockSupported: llSupported,
            b0TimestampSupported: b0Verdict,
            b1SuspectGraphSupported: b1Verdict,
            b2VersionEnvelopeSupported: b2Verdict,
            hasDiscrepancy:
              llSupported !== b0Verdict || llSupported !== b1Verdict || llSupported !== b2Verdict
          };
        })
        .filter((d) => d.hasDiscrepancy);

      return {
        authority: "READ_ONLY_BASELINE_AUDIT",
        issueKey: issue.issueKey,
        gateState: cmp.linelock.gateState,
        discrepancyCount: discrepancies.length,
        discrepancies
      };
    }
  };
}
