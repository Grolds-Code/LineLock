import Resolver from "@forge/resolver";
import {
  assertUserCanReadIssue,
  assertUserCanReadProject,
  assertUserIssuePermissions,
  assertUserProjectPermissions
} from "./userAuthorization";
import { Queue } from "@forge/events";
import type { ChangeOperation } from "../core/types";
import { buildHeliosCapRevCSubstitution } from "../scenarios/heliosBatteryPack";
import { ForgeJiraPlatformGateway } from "./jiraGateway";
import type {
  BindJiraEvidenceRequest,
  CounterfactualRequest,
  CustomComponentSubstitutionRequest,
  GovernancePolicyMode,
  IndustryTemplateId,
  ScenarioPresetId,
  type StoredEcoWorkspace
} from "./ports";
import { SqlProvisioningManager } from "./provisioning";
import { createRovoActionHandlers } from "./rovo";
import { LineLockService } from "./service";
import { ForgeSqlCasStore } from "./sqlStore";

const provisioningManager = new SqlProvisioningManager();
const sqlStore = new ForgeSqlCasStore();
const jiraGateway = new ForgeJiraPlatformGateway();

export const defaultLineLockService = new LineLockService({
  store: sqlStore,
  jira: jiraGateway,
  provisioning: provisioningManager
});

const rovoHandlers = createRovoActionHandlers({
  service: defaultLineLockService,
  jira: jiraGateway
});

const schemaMigrationQueue = new Queue({ key: "schema-migration-queue" });

interface IssuePanelContext {
  readonly accountId?: string;
  readonly extension?: {
    readonly issue?: {
      readonly id?: string | number;
      readonly key?: string;
    };
    readonly project?: {
      readonly key?: string;
    };
  };
}

function extractIssueContext(rawContext: unknown): {
  readonly accountId: string;
  readonly issueId: string;
  readonly issueKey: string;
  readonly projectKey: string;
} {
  const ctx = (rawContext ?? {}) as IssuePanelContext;
  const accountId = ctx.accountId ?? "";
  const issueId = ctx.extension?.issue?.id !== undefined ? String(ctx.extension.issue.id) : "";
  const issueKey = ctx.extension?.issue?.key ?? "";
  const projectKey = ctx.extension?.project?.key ?? (issueKey.split("-")[0] ?? "");
  if (!issueId || !projectKey) {
    throw new Error("Missing Jira issueId or projectKey in Forge resolver context.");
  }
  return { accountId, issueId, issueKey, projectKey };
}

function extractProjectContext(rawContext: unknown): {
  readonly accountId: string;
  readonly projectKey: string;
} {
  const ctx = (rawContext ?? {}) as IssuePanelContext;
  const accountId = ctx.accountId ?? "";
  const issueKey = ctx.extension?.issue?.key ?? "";
  const projectKey = ctx.extension?.project?.key ?? (issueKey.split("-")[0] ?? "");
  if (!projectKey) {
    throw new Error("Missing Jira projectKey in Forge project page resolver context.");
  }
  return { accountId, projectKey };
}

/** Authorization is checked against Jira as the invoking user, never asApp. */
async function assertWorkspaceVisible(ws: StoredEcoWorkspace): Promise<void> {
  await assertUserCanReadIssue(ws.ecoIssueId);
  // A readable ECO is not permission to disclose restricted linked lab issues.
  // All evidence must be accessible to the user before a detailed view is exposed.
  await Promise.all(
    ws.catalog.evidenceRecords.map((ev) => assertUserCanReadIssue(ev.jiraIssueId))
  );
}

async function canViewWorkspace(ws: StoredEcoWorkspace): Promise<boolean> {
  try {
    await assertWorkspaceVisible(ws);
    return true;
  } catch {
    return false;
  }
}

async function authorizedWorkspaceView(params: {
  readonly projectKey: string;
  readonly ecoIssueId: string;
  readonly callerAccountId?: string;
}) {
  await assertUserCanReadIssue(params.ecoIssueId);
  const view = await defaultLineLockService.getWorkspaceView(params);
  if (view.workspace) await assertWorkspaceVisible(view.workspace);
  return view;
}

/** Rovo's issue key is untrusted tool input, even when inferred from chat context. */
function resolveRovoIssueKey(payload: unknown): string {
  const p = (payload ?? {}) as {
    readonly issueKey?: string;
    readonly context?: {
      readonly issueKey?: string;
      readonly jira?: { readonly issueKey?: string };
    };
  };
  const candidate = p.issueKey ?? p.context?.jira?.issueKey ?? p.context?.issueKey;
  const key = typeof candidate === "string" ? candidate.trim() : "";
  if (!key) throw new Error("Select a Jira engineering change or supply its issue key.");
  return key;
}

async function authorizeRovoIssue(issueKey: string): Promise<void> {
  await assertUserCanReadIssue(issueKey);
  const provisioning = await provisioningManager.inspectStatus();
  if (provisioning.state !== "READY") return;
  const issue = await jiraGateway.fetchLiveIssueByKeyOrId(issueKey);
  const ws = await sqlStore.getEcoWorkspace(issue.issueId);
  if (ws) await assertWorkspaceVisible(ws);
}

const resolver = new Resolver();

resolver.define("probeConnectivity", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserCanReadIssue(ctx.issueId);
  return defaultLineLockService.runConnectivityProbe({
    projectKey: ctx.projectKey,
    issueId: ctx.issueId
  });
});

resolver.define("triggerProvisioningRecovery", async (req) => {
  const ctx = extractProjectContext(req.context);
  await assertUserProjectPermissions(ctx.projectKey, ["ADMINISTER_PROJECTS"]);
  return defaultLineLockService.triggerProvisioningRecovery("manual-panel-recovery");
});

resolver.define("getWorkspaceView", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserCanReadIssue(ctx.issueId);
  return authorizedWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
});

resolver.define("getProjectFleetOverview", async (req) => {
  const ctx = extractProjectContext(req.context);
  // No client-controlled projectKey override. The project is signed by Forge.
  await assertUserCanReadProject(ctx.projectKey);
  return defaultLineLockService.getProjectFleetOverview({
    projectKey: ctx.projectKey,
    callerAccountId: ctx.accountId,
    canViewWorkspace
  });
});

resolver.define("seedHeliosWorkspace", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as { readonly templateId?: IndustryTemplateId };
  await defaultLineLockService.seedReferenceWorkspace({
    ecoIssueId: ctx.issueId,
    ecoIssueKey: ctx.issueKey,
    callerAccountId: ctx.accountId,
    templateId: payload.templateId
  });
  return authorizedWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
});

resolver.define("provisionLiveJiraWorkspace", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
    await assertUserProjectPermissions(ctx.projectKey, ["CREATE_ISSUES", "TRANSITION_ISSUES"]);
  const payload = (req.payload ?? {}) as { readonly templateId?: IndustryTemplateId };
  return defaultLineLockService.provisionLiveJiraWorkspace({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    ecoIssueKey: ctx.issueKey,
    callerAccountId: ctx.accountId,
    templateId: payload.templateId
  });
});

resolver.define("applyScenarioPreset", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly presetId: ScenarioPresetId;
  };
  return defaultLineLockService.applyScenarioPreset({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    presetId: payload.presetId
  });
});

resolver.define("simulateCounterfactual", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserCanReadIssue(ctx.issueId);
  const payload = (req.payload ?? {}) as {
    readonly request: CounterfactualRequest;
    readonly includeBaselines?: boolean;
  };
  return defaultLineLockService.simulateCounterfactual({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    request: payload.request,
    includeBaselines: payload.includeBaselines ?? true
  });
});

resolver.define("commitCounterfactualOperations", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly proposedOperations: readonly ChangeOperation[];
  };
  await defaultLineLockService.commitProposalOperations({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    proposedOperations: payload.proposedOperations
  });
  return authorizedWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
});

resolver.define("authorCustomComponentSubstitution", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly request: CustomComponentSubstitutionRequest;
  };
  return defaultLineLockService.authorCustomComponentSubstitution({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    request: payload.request
  });
});

resolver.define("bindCustomJiraEvidenceTicket", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly request: BindJiraEvidenceRequest;
  };
  await assertUserCanReadIssue(payload.request.jiraIssueKeyOrId);
  return defaultLineLockService.bindCustomJiraEvidenceTicket({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    request: payload.request
  });
});

resolver.define("switchGovernancePolicyMode", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserProjectPermissions(ctx.projectKey, ["ADMINISTER_PROJECTS"]);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly mode: GovernancePolicyMode;
  };
  return defaultLineLockService.switchGovernancePolicyMode({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    mode: payload.mode
  });
});

resolver.define("proposeCapRevCFrom5000", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly targetVariants?: "ALL" | readonly string[];
  };
  const current = await defaultLineLockService.getWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
  if (!current.workspace) {
    throw new Error("Seed the ECO workspace before proposing BOM operations.");
  }
  const ops = buildHeliosCapRevCSubstitution(
    current.workspace.catalog,
    payload.targetVariants ?? "ALL",
    5000
  );
  await defaultLineLockService.commitProposalOperations({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    proposedOperations: ops
  });
  return authorizedWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
});

resolver.define("revertToBaselineBom", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as { readonly expectedRevisionSeq: number };
  await defaultLineLockService.commitProposalOperations({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    proposedOperations: []
  });
  return authorizedWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
});

resolver.define("signRoleAttestation", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserCanReadIssue(ctx.issueId);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly expectedSnapshotSha256: string;
    readonly expectedApprovalGeneration: number;
    readonly roleName: string;
    readonly rationale: string;
  };
  await defaultLineLockService.recordHumanAttestation({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    expectedSnapshotSha256: payload.expectedSnapshotSha256,
    expectedApprovalGeneration: payload.expectedApprovalGeneration,
    signerAccountId: ctx.accountId,
    roleName: payload.roleName,
    rationale: payload.rationale
  });
  return authorizedWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
});

resolver.define("repinLiveEvidenceHashes", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["EDIT_ISSUES"]);
  const payload = (req.payload ?? {}) as { readonly expectedRevisionSeq: number };
  return defaultLineLockService.repinLiveEvidenceHashes({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId
  });
});

resolver.define("postAuditRecordComment", async (req) => {
  const ctx = extractIssueContext(req.context);
  await assertUserIssuePermissions(ctx.issueId, ["ADD_COMMENTS"]);
  return defaultLineLockService.postAuditRecordComment({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    callerAccountId: ctx.accountId
  });
});

export const panelResolverHandler = resolver.getDefinitions();

export async function workflowValidatorHandler(event: {
  readonly issue?: {
    readonly id?: string | number;
    readonly key?: string;
    readonly fields?: { readonly project?: { readonly key?: string } };
  };
  readonly user?: { readonly accountId?: string };
}): Promise<{ readonly result: boolean; readonly errorMessage?: string }> {
  const issueId = event.issue?.id !== undefined ? String(event.issue.id) : "";
  const issueKey = event.issue?.key ?? "";
  const projectKey = event.issue?.fields?.project?.key ?? (issueKey.split("-")[0] ?? "");
  const actorAccountId = event.user?.accountId ?? "unknown-actor";

  if (!issueId || !projectKey) {
    return {
      result: false,
      errorMessage:
        "LineLock fail-closed: Missing issueId or projectKey in workflow validator event."
    };
  }

  return defaultLineLockService.validateReleaseTransition({
    projectKey,
    ecoIssueId: issueId,
    actorAccountId
  });
}

export async function issueUpdatedTriggerHandler(event: {
  readonly issue?: {
    readonly id?: string | number;
    readonly key?: string;
    readonly fields?: { readonly project?: { readonly key?: string } };
  };
}): Promise<void> {
  const issueId = event.issue?.id !== undefined ? String(event.issue.id) : "";
  const issueKey = event.issue?.key ?? "";
  const projectKey = event.issue?.fields?.project?.key ?? (issueKey.split("-")[0] ?? "");
  if (!issueId || !projectKey) {
    return;
  }
  await defaultLineLockService.reconcileIssueUpdatedEvent({
    projectKey,
    updatedIssueId: issueId
  });
}

export async function lifecycleInstallTriggerHandler(event: {
  readonly eventType?: string;
}): Promise<void> {
  const source = event.eventType ?? "avi:forge:installed:app";
  try {
    await schemaMigrationQueue.push({ body: { triggerSource: source } });
  } catch {
    await defaultLineLockService.triggerProvisioningRecovery(`${source}:direct-fallback`);
  }
}

export async function migrationQueueConsumerHandler(event: {
  readonly body?: { readonly triggerSource?: string };
}): Promise<void> {
  const source = event.body?.triggerSource ?? "schema-migration-queue";
  await defaultLineLockService.triggerProvisioningRecovery(source);
}

export async function rovoInspectEcoHandler(payload: { readonly issueKey?: string }) {
  const issueKey = resolveRovoIssueKey(payload);
  await authorizeRovoIssue(issueKey);
  return rovoHandlers.inspectEcoAssurance({ ...payload, issueKey });
}

export async function rovoSimulateCutoverHandler(payload: {
  readonly issueKey?: string;
  readonly variantScope?: string;
  readonly serialFrom?: number;
  readonly serialTo?: number;
}) {
  const issueKey = resolveRovoIssueKey(payload);
  await authorizeRovoIssue(issueKey);
  return rovoHandlers.simulateSerialCutover({ ...payload, issueKey });
}

export async function rovoCompareBaselinesHandler(payload: { readonly issueKey?: string }) {
  const issueKey = resolveRovoIssueKey(payload);
  await authorizeRovoIssue(issueKey);
  return rovoHandlers.compareBaselines({ ...payload, issueKey });
}

export async function rovoFleetOverviewHandler(payload: { readonly projectKey?: string }) {
  const key = payload.projectKey?.trim() ?? "";
  await assertUserCanReadProject(key);
  return rovoHandlers.inspectProjectFleet({ projectKey: key }, { canViewWorkspace });
}

export * from "./ports";
export * from "./provisioning";
export * from "./sqlStore";
export * from "./jiraGateway";
export * from "./service";
export * from "./rovo";
