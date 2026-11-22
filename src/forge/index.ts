import Resolver from "@forge/resolver";
import { Queue } from "@forge/events";
import { buildHeliosCapRevCSubstitution } from "../scenarios/heliosBatteryPack";
import { ForgeJiraPlatformGateway } from "./jiraGateway";
import { SqlProvisioningManager } from "./provisioning";
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

const resolver = new Resolver();

resolver.define("probeConnectivity", async (req) => {
  const ctx = extractIssueContext(req.context);
  return defaultLineLockService.runConnectivityProbe({
    projectKey: ctx.projectKey,
    issueId: ctx.issueId
  });
});

resolver.define("triggerProvisioningRecovery", async () => {
  return defaultLineLockService.triggerProvisioningRecovery("manual-panel-recovery");
});

resolver.define("getWorkspaceView", async (req) => {
  const ctx = extractIssueContext(req.context);
  return defaultLineLockService.getWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId
  });
});

resolver.define("seedHeliosWorkspace", async (req) => {
  const ctx = extractIssueContext(req.context);
  await defaultLineLockService.seedReferenceWorkspace({
    ecoIssueId: ctx.issueId,
    ecoIssueKey: ctx.issueKey,
    callerAccountId: ctx.accountId
  });
  return defaultLineLockService.getWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId
  });
});

resolver.define("proposeCapRevCFrom5000", async (req) => {
  const ctx = extractIssueContext(req.context);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly targetVariants?: "ALL" | readonly string[];
  };
  const current = await defaultLineLockService.getWorkspaceView({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId
  });
  if (!current.workspace) {
    throw new Error("Seed the ECO workspace before proposing BOM operations.");
  }
  const ops = buildHeliosCapRevCSubstitution(
    current.workspace.catalog,
    payload.targetVariants ?? "ALL",
    5000
  );
  return defaultLineLockService.commitProposalOperations({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    proposedOperations: ops
  });
});

resolver.define("revertToBaselineBom", async (req) => {
  const ctx = extractIssueContext(req.context);
  const payload = (req.payload ?? {}) as { readonly expectedRevisionSeq: number };
  return defaultLineLockService.commitProposalOperations({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    callerAccountId: ctx.accountId,
    proposedOperations: []
  });
});

resolver.define("signRoleAttestation", async (req) => {
  const ctx = extractIssueContext(req.context);
  const payload = (req.payload ?? {}) as {
    readonly expectedRevisionSeq: number;
    readonly expectedSnapshotSha256: string;
    readonly expectedApprovalGeneration: number;
    readonly roleName: string;
    readonly rationale: string;
  };
  return defaultLineLockService.recordHumanAttestation({
    projectKey: ctx.projectKey,
    ecoIssueId: ctx.issueId,
    expectedRevisionSeq: payload.expectedRevisionSeq,
    expectedSnapshotSha256: payload.expectedSnapshotSha256,
    expectedApprovalGeneration: payload.expectedApprovalGeneration,
    signerAccountId: ctx.accountId,
    roleName: payload.roleName,
    rationale: payload.rationale
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
      errorMessage: "LineLock fail-closed: Missing issueId or projectKey in workflow validator event."
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

export * from "./ports";
export * from "./provisioning";
export * from "./sqlStore";
export * from "./jiraGateway";
export * from "./service";
