import type {
  EcoMetadata,
  FamilyCatalog,
  FinalizedReleaseReceipt,
  SerialInterval,
  VerificationEvaluation
} from "./types";

function fmtInterval(interval: SerialInterval): string {
  const hi = interval.serialTo === null ? "+inf" : String(interval.serialTo);
  return `[SN ${interval.serialFrom}..${hi})`;
}

function escapeMdCell(raw: string): string {
  return raw.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/**
 * Pure, deterministic Engineering Change Verification & Effectivity Disposition Record generator.
 *
 * Trust-Boundary & Scope Invariant:
 * - Zero Forge SDK, network, or wall-clock imports.
 * - Identical inputs produce byte-for-byte identical Markdown output.
 * - Explicitly documents LineLock's verification scope (recorded engineering evidence &
 *   configuration applicability — never physical product safety or statutory certification).
 */
export function buildReleaseAssuranceMarkdown(params: {
  readonly catalog: FamilyCatalog;
  readonly eco: EcoMetadata;
  readonly evaluation: VerificationEvaluation;
  readonly finalizedReceipt: FinalizedReleaseReceipt | null;
}): string {
  const { catalog, eco, evaluation, finalizedReceipt } = params;
  const evById = new Map(catalog.evidenceRecords.map((ev) => [ev.evidenceId, ev]));

  const supportedCount = evaluation.sliceObligations.filter(
    (s) => s.status === "SUPPORTED_AS_TESTED" || s.status === "SUPPORTED_BY_APPROVED_RULE"
  ).length;

  const lines: string[] = [];

  lines.push(`# LineLock Engineering Evidence & Effectivity Disposition Record`);
  lines.push("");
  lines.push(
    `> **Scope Notice:** LineLock performs deterministic, effectivity-aware verification of recorded engineering evidence against resolved BOM configurations, operating envelopes, and explicitly authorized Strong Kleene ($K_3$) carry-forward rules. It does **not** certify physical product safety or statutory regulatory compliance.`
  );
  lines.push("");

  lines.push(`## 1. Cryptographic Snapshot & Gate Summary`);
  lines.push(`- **ECO Work Item:** \`${eco.ecoJiraKey}\` (\`issueId=${eco.ecoJiraIssueId}\`)`);
  lines.push(`- **Product Family:** \`${catalog.familyId}\` (Root Assembly \`${catalog.rootAssemblyRevId}\`)`);
  lines.push(`- **Gate Verdict:** \`${evaluation.gateState}\` (\`transitionAllowed=${String(evaluation.transitionAllowed)}\`)`);
  lines.push(`- **Canonical Snapshot SHA-256 (RFC 8785):** \`${evaluation.snapshotSha256}\``);
  lines.push(`- **Monotonic Approval Generation:** \`${evaluation.approvalGeneration}\``);
  lines.push(
    `- **Governance Policy:** \`${catalog.policy.policyId}\` (\`v${evaluation.policyVersion}\`, \`separationOfDuties=${String(catalog.policy.enforceSeparationOfDuties)}\`)`
  );
  lines.push(
    `- **Effective Slices / Obligations Supported:** \`${evaluation.slices.length}\` slices · \`${supportedCount} / ${evaluation.sliceObligations.length}\` obligations supported`
  );
  if (finalizedReceipt) {
    lines.push(
      `- **Phase-2 Finalized Release Receipt:** \`${finalizedReceipt.receiptId}\` (source intent \`${finalizedReceipt.sourceIntentId}\`, verified digest \`${finalizedReceipt.verifiedSnapshotSha256.slice(0, 16)}...\`, gen \`${finalizedReceipt.verifiedApprovalGeneration}\`)`
    );
  } else {
    lines.push(`- **Phase-2 Finalized Release Receipt:** \`NONE (pre-release or pending)\``);
  }
  lines.push("");

  lines.push(`## 2. Serial-Effectivity × Obligation Assurance Matrix`);
  lines.push(
    `| Variant | Serial Interval | Obligation | Verdict | Evidence & Pinned SHA-256 | Rule / Changed Slots |`
  );
  lines.push(`|---|---|---|---|---|---|`);

  for (const so of evaluation.sliceObligations) {
    const ev = so.supportingEvidenceId ? evById.get(so.supportingEvidenceId) : undefined;
    const evCol = ev
      ? `\`${ev.jiraIssueKey}\` (\`${ev.pinnedIssueStateHash.slice(0, 12)}...\`)`
      : so.supportingEvidenceId
        ? `\`${so.supportingEvidenceId}\``
        : `None`;

    const changeNotes: string[] = [];
    if (so.appliedCarryForwardRuleId) {
      changeNotes.push(`Rule \`${so.appliedCarryForwardRuleId}\``);
    }
    if (so.changedGovernedSlots.length > 0) {
      changeNotes.push(`Gov: \`${so.changedGovernedSlots.join(", ")}\``);
    }
    if (so.changedExcludedSlots.length > 0) {
      changeNotes.push(`Excl: \`${so.changedExcludedSlots.join(", ")}\``);
    }
    if (changeNotes.length === 0) {
      changeNotes.push(`Exact baseline match`);
    }

    lines.push(
      `| \`${escapeMdCell(so.variantId)}\` | \`${fmtInterval(so.interval)}\` | \`${escapeMdCell(so.obligationCode)}\` | \`${so.status}\` | ${evCol} | ${escapeMdCell(changeNotes.join("; "))} |`
    );
  }
  lines.push("");

  lines.push(`## 3. Generation-Bound Role Attestations`);
  lines.push(
    `- **Required Roles:** ${evaluation.attestationSummary.requiredRoles.map((r) => `\`${r}\``).join(", ") || "`none`"}`
  );
  lines.push(
    `- **Satisfied Roles:** ${evaluation.attestationSummary.satisfiedRoles.map((r) => `\`${r}\``).join(", ") || "`none`"}`
  );
  lines.push(
    `- **Missing Roles:** ${evaluation.attestationSummary.missingRoles.map((r) => `\`${r}\``).join(", ") || "`none`"}`
  );

  if (evaluation.attestationSummary.acceptedAttestations.length > 0) {
    lines.push("");
    lines.push(`| Attestation ID | Role | Signer Account ID | Bound Gen & Policy | Rationale |`);
    lines.push(`|---|---|---|---|---|`);
    for (const att of evaluation.attestationSummary.acceptedAttestations) {
      lines.push(
        `| \`${escapeMdCell(att.attestationId)}\` | \`${escapeMdCell(att.roleName)}\` | \`${escapeMdCell(att.signerAccountId)}\` | \`Gen ${att.attestedApprovalGeneration} / v${att.attestedPolicyVersion}\` | ${escapeMdCell(att.rationale)} |`
      );
    }
  }

  if (evaluation.attestationSummary.rejectedReasons.length > 0) {
    lines.push("");
    lines.push(`### Invalidated / Rejected Prior Attestations (ABA & Drift Protection)`);
    for (const rej of evaluation.attestationSummary.rejectedReasons) {
      lines.push(`- \`${rej.attestationId}\`: ${rej.reason}`);
    }
  }
  lines.push("");

  if (evaluation.blockingReasons.length > 0) {
    lines.push(`## 4. Active Release Gate Blockers`);
    for (const b of evaluation.blockingReasons) {
      lines.push(`- ${b}`);
    }
    lines.push("");
  }

  if (evaluation.remediationPlans.length > 0) {
    lines.push(`## 5. Minimum Bounded Verification Remediation Plan`);
    for (const plan of evaluation.remediationPlans) {
      lines.push(
        `- **\`${plan.obligationCode}\`** (\`solver=${plan.solverMode}\`, \`${plan.unsatisfiedSliceIds.length}\` unsatisfied slice(s)):`
      );
      for (const act of plan.selectedActions) {
        lines.push(
          `  - Execute \`${act.obligationCode}\` on \`${act.targetVariantId}\` \`${fmtInterval(act.targetInterval)}\` covering \`[${act.coveredSliceIds.join(", ")}]\` with binding \`${JSON.stringify(act.requiredSlotBindings)}\``
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
