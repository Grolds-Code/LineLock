import * as forgeApiMod from "@forge/api";
import api, { route } from "@forge/api";
import type { LiveJiraIssueProjection, ScalarValue } from "../core/types";
import type {
  ConnectivityProbeResult,
  JiraPlatformGateway,
  ProvisionedVerificationIssue,
  VerificationIssueSeedSpec
} from "./ports";

type ForgeRequestInit = Parameters<ReturnType<typeof api.asApp>["requestJira"]>[1];
type ForgeResponse = Awaited<ReturnType<ReturnType<typeof api.asApp>["requestJira"]>>;

function isUnavailableTokenProxyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("UNAVAILABLE_TOKEN_ERROR") ||
    msg.includes("PROXY_ERR") ||
    msg.includes("failed to process runtime HTTP request")
  );
}

function resolveInstalledJiraContextAri(): string | null {
  try {
    const maybeGetCtx = (forgeApiMod as { getAppContext?: () => unknown }).getAppContext;
    if (typeof maybeGetCtx !== "function") return null;
    const appCtx = maybeGetCtx() as {
      installation?: {
        contexts?: readonly { toString?: () => string; cloudId?: string }[];
      };
    };
    for (const ctx of appCtx?.installation?.contexts ?? []) {
      const str = typeof ctx?.toString === "function" ? ctx.toString() : "";
      if (str.includes(":jira:")) {
        return str;
      }
      if (ctx?.cloudId) {
        return `ari:cloud:jira::site/${ctx.cloudId}`;
      }
    }
  } catch {
    // Non-Forge test environment
  }
  return null;
}

interface JiraIssueRestResponse {
  readonly id: string;
  readonly key: string;
  readonly fields: {
    readonly summary?: string;
    readonly issuetype?: { readonly id?: string; readonly name?: string };
    readonly description?: unknown;
    readonly attachment?: readonly {
      readonly id?: string;
      readonly filename?: string;
      readonly size?: number;
      readonly mimeType?: string;
      readonly created?: string;
    }[];
    readonly updated?: string;
    readonly project?: {
      readonly key?: string;
    };
    readonly status?: {
      readonly statusCategory?: {
        readonly key?: string;
      };
    };
    readonly resolution?: {
      readonly name?: string;
    } | null;
  };
}

interface JiraProjectDetailsResponse {
  readonly key?: string;
  readonly issueTypes?: readonly {
    readonly id: string;
    readonly name: string;
    readonly subtask?: boolean;
  }[];
}

interface JiraTransitionsResponse {
  readonly transitions?: readonly {
    readonly id: string;
    readonly name: string;
    readonly to?: {
      readonly statusCategory?: {
        readonly key?: string;
      };
    };
  }[];
}

interface JiraIssueLinkTypesResponse {
  readonly issueLinkTypes?: readonly {
    readonly name: string;
  }[];
}

interface JiraRoleDetailsResponse {
  readonly actors?: readonly {
    readonly type?: string;
    readonly name?: string;
    readonly actorUser?: {
      readonly accountId?: string;
    };
    readonly actorGroup?: {
      readonly groupId?: string;
      readonly name?: string;
      readonly displayName?: string;
    };
  }[];
}

interface JiraUserGroupItem {
  readonly groupId?: string;
  readonly name?: string;
}

interface JiraMyselfResponse {
  readonly accountId?: string;
  readonly displayName?: string;
}

interface JiraServerInfoResponse {
  readonly baseUrl?: string;
  readonly deploymentType?: string;
}

function extractAdfPlainText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const rec = node as Record<string, unknown>;
  if (typeof rec["text"] === "string") return rec["text"];
  if (Array.isArray(rec["content"])) {
    return rec["content"].map(extractAdfPlainText).join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function buildAdfDocument(plainText: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: plainText
          }
        ]
      }
    ]
  };
}

function buildAuditCommentAdf(markdownText: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "LineLock Deterministic Release Assurance & Effectivity Disposition Record",
            marks: [{ type: "strong" }]
          }
        ]
      },
      {
        type: "codeBlock",
        attrs: { language: "markdown" },
        content: [
          {
            type: "text",
            text: markdownText
          }
        ]
      }
    ]
  };
}

/**
 * Jira Cloud REST v3 gateway using official `@forge/api` endpoints.
 * Preserves 100% `Runs on Atlassian` eligibility (zero external egress) and automatically
 * resolves multi-context Space/MCP invocations (`withContext` + `asUser` fallback) when
 * Forge's runtime proxy returns `UNAVAILABLE_TOKEN_ERROR` on contextless `asApp()`.
 */
export class ForgeJiraPlatformGateway implements JiraPlatformGateway {
  constructor(private readonly accessMode: "app" | "user" = "app") {}

  private async requestJiraResilient(
    path: ReturnType<typeof route>,
    init?: ForgeRequestInit
  ): Promise<ForgeResponse> {
    // Rovo's entire live Jira read call graph runs under the principal.
    // Never fall back from asUser to asApp on missing consent or token errors.
    if (this.accessMode === "user") {
      return api.asUser().requestJira(path, init);
    }
    let primaryErr: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await api.asApp().requestJira(path, init);
      } catch (err) {
        primaryErr = err;
        if (!isUnavailableTokenProxyError(err)) {
          throw err;
        }
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }

    const jiraContextAri = resolveInstalledJiraContextAri();
    const appClient = api.asApp() as {
      withContext?: (ari: string) => {
        requestJira: (p: ReturnType<typeof route>, i?: ForgeRequestInit) => Promise<ForgeResponse>;
      };
    };
    if (jiraContextAri && typeof appClient.withContext === "function") {
      try {
        return await appClient.withContext(jiraContextAri).requestJira(path, init);
      } catch (err) {
        if (!isUnavailableTokenProxyError(err)) {
          throw err;
        }
      }
    }

    try {
      return await api.asUser().requestJira(path, init);
    } catch (userErr) {
      const userClient = api.asUser() as {
        withContext?: (ari: string) => {
          requestJira: (p: ReturnType<typeof route>, i?: ForgeRequestInit) => Promise<ForgeResponse>;
        };
      };
      if (jiraContextAri && typeof userClient.withContext === "function") {
        try {
          return await userClient.withContext(jiraContextAri).requestJira(path, init);
        } catch {
          throw primaryErr ?? userErr;
        }
      }
      throw primaryErr ?? userErr;
    }
  }

  public async fetchLiveIssue(issueId: string): Promise<LiveJiraIssueProjection> {
    const full = await this.fetchLiveIssueByKeyOrId(issueId);
    const { projectKey: _ignored, ...projection } = full;
    return projection;
  }

  public async fetchLiveIssueByKeyOrId(
    issueKeyOrId: string
  ): Promise<LiveJiraIssueProjection & { readonly projectKey: string }> {
    const res = await this.requestJiraResilient(
      route`/rest/api/3/issue/${issueKeyOrId}?fields=summary,description,attachment,status,resolution,updated,project,issuetype`,
      { headers: { Accept: "application/json" } }
    );

    if (!res.ok) {
      throw new Error(`Jira REST fetch failed for issue "${issueKeyOrId}": HTTP ${res.status}`);
    }

    const body = (await res.json()) as JiraIssueRestResponse;
    const updatedMs = body.fields.updated ? Date.parse(body.fields.updated) : 0;
    const structuredFields: Record<string, ScalarValue> = {};
    const projectKey = body.fields.project?.key ?? (body.key.split("-")[0] ?? "");

    return {
      issueId: String(body.id),
      issueKey: body.key,
      projectKey,
      issueTypeId: body.fields.issuetype?.id,
      issueTypeName: body.fields.issuetype?.name,
      summary: body.fields.summary ?? "",
      description: extractAdfPlainText(body.fields.description),
      descriptionAdf: body.fields.description ?? null,
      attachmentMetadata: (body.fields.attachment ?? [])
        .filter((a) => a.id && a.filename)
        .map((a) => ({
          id: a.id!,
          filename: a.filename!,
          size: a.size ?? 0,
          mimeType: a.mimeType ?? "",
          created: a.created ?? ""
        })),
      statusCategoryKey: body.fields.status?.statusCategory?.key ?? "unknown",
      resolutionName: body.fields.resolution?.name ?? null,
      updatedAtEpochMs: Number.isFinite(updatedMs) ? updatedMs : 0,
      structuredFields
    };
  }

  public async fetchProjectRoleMembers(
    projectKey: string,
    requiredRoles: readonly string[],
    candidateAccountIds: readonly string[] = []
  ): Promise<Record<string, readonly string[]>> {
    const rolesRes = await this.requestJiraResilient(
      route`/rest/api/3/project/${projectKey}/role`,
      {
        headers: { Accept: "application/json" }
      }
    );

    if (!rolesRes.ok) {
      throw new Error(
        `Jira REST role directory fetch failed for project "${projectKey}": HTTP ${rolesRes.status}`
      );
    }

    const roleUrlMap = (await rolesRes.json()) as Record<string, string>;
    const directUsersByRole = new Map<string, Set<string>>();
    const groupIdsByRole = new Map<string, Set<string>>();
    const groupNamesByRole = new Map<string, Set<string>>();
    let anyRoleHasGroups = false;

    for (const roleName of requiredRoles) {
      const userSet = new Set<string>();
      const groupIdSet = new Set<string>();
      const groupNameSet = new Set<string>();
      directUsersByRole.set(roleName, userSet);
      groupIdsByRole.set(roleName, groupIdSet);
      groupNamesByRole.set(roleName, groupNameSet);

      const roleUrl = roleUrlMap[roleName];
      if (!roleUrl) {
        continue;
      }
      const match = /\/role\/(\d+)$/.exec(roleUrl);
      if (!match?.[1]) {
        continue;
      }
      const roleId = match[1];
      const detailRes = await this.requestJiraResilient(
        route`/rest/api/3/project/${projectKey}/role/${roleId}`,
        {
          headers: { Accept: "application/json" }
        }
      );

      if (!detailRes.ok) {
        continue;
      }

      const detail = (await detailRes.json()) as JiraRoleDetailsResponse;
      for (const actor of detail.actors ?? []) {
        if (actor.actorUser?.accountId) {
          userSet.add(actor.actorUser.accountId);
        }
        const gId = actor.actorGroup?.groupId?.trim();
        if (gId) {
          groupIdSet.add(gId);
          anyRoleHasGroups = true;
        }
        for (const rawName of [
          actor.actorGroup?.name,
          actor.actorGroup?.displayName,
          actor.type === "atlassian-group-role-actor" ? actor.name : undefined
        ]) {
          const norm = rawName?.trim().toLowerCase();
          if (norm) {
            groupNameSet.add(norm);
            anyRoleHasGroups = true;
          }
        }
      }
    }

    const uniqueCandidates = [
      ...new Set(candidateAccountIds.map((id) => id.trim()).filter((id) => id.length > 0))
    ];

    if (anyRoleHasGroups && uniqueCandidates.length > 0) {
      await Promise.all(
        uniqueCandidates.map(async (accountId) => {
          const userGroups = await this.fetchUserGroupsSafe(accountId);
          if (userGroups.length === 0) return;

          for (const roleName of requiredRoles) {
            const roleGroupIds = groupIdsByRole.get(roleName);
            const roleGroupNames = groupNamesByRole.get(roleName);
            const userSet = directUsersByRole.get(roleName);
            if (!userSet) continue;

            const matchesGroup = userGroups.some((ug) => {
              const ugId = ug.groupId?.trim();
              const ugName = ug.name?.trim().toLowerCase();
              return (
                Boolean(ugId && roleGroupIds?.has(ugId)) ||
                Boolean(ugName && roleGroupNames?.has(ugName))
              );
            });
            if (matchesGroup) {
              userSet.add(accountId);
            }
          }
        })
      );
    }

    const result: Record<string, readonly string[]> = {};
    for (const roleName of requiredRoles) {
      result[roleName] = [...(directUsersByRole.get(roleName) ?? [])].sort();
    }
    return result;
  }

  /**
   * Provisions real Jira verification work items inside `projectKey`, transitions each
   * into its Done status category, links it to `ecoIssueKey`, and returns the live
   * Jira projections so their SHA-256 content hashes can be pinned deterministically.
   */
  public async provisionVerificationIssues(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly specs: readonly VerificationIssueSeedSpec[];
    readonly onCreatedBeforeTransition?: (createdIssueIds: readonly string[]) => Promise<void>;
  }): Promise<readonly ProvisionedVerificationIssue[]> {
    const issueTypeId = await this.resolveStandardIssueTypeId(params.projectKey);
    const linkTypeName = await this.resolveDefaultLinkTypeName();
    if (params.ecoIssueKey && !linkTypeName) {
      throw new Error(
        "Cannot provision traceable qualification issues: Jira issue linking is unavailable or the app cannot read link types."
      );
    }

    const createdItems: {
      readonly evidenceId: string;
      readonly id: string;
      readonly key: string;
    }[] = [];

    for (const spec of params.specs) {
      const createRes = await this.requestJiraResilient(route`/rest/api/3/issue`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fields: {
            project: { key: params.projectKey },
            issuetype: { id: issueTypeId },
            summary: spec.summary,
            description: buildAdfDocument(spec.description)
          }
        })
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(
          `Failed creating verification issue "${spec.evidenceId}" in project "${params.projectKey}": HTTP ${createRes.status} (${errText.slice(0, 180)})`
        );
      }

      const created = (await createRes.json()) as { readonly id: string; readonly key: string };
      createdItems.push({
        evidenceId: spec.evidenceId,
        id: String(created.id),
        key: created.key
      });
    }

    // Register newly created child test issue IDs in Forge SQL BEFORE transitioning them to Done
    // so shared-project workflow validators recognize them as test tickets rather than uninitialized ECOs.
    if (params.onCreatedBeforeTransition) {
      await params.onCreatedBeforeTransition(createdItems.map((c) => c.id));
    }

    const provisioned: ProvisionedVerificationIssue[] = [];

    for (const item of createdItems) {
      await this.transitionIssueToDoneCategory(item.id);

      if (linkTypeName && params.ecoIssueKey) {
        const linkRes = await this.requestJiraResilient(route`/rest/api/3/issueLink`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            type: { name: linkTypeName },
            inwardIssue: { key: item.key },
            outwardIssue: { key: params.ecoIssueKey }
          })
        });
        if (!linkRes.ok) {
          throw new Error(
            `Qualification ticket ${item.key} could not be linked to ECO ${params.ecoIssueKey}: Jira HTTP ${linkRes.status}. Resolve link permissions before continuing.`
          );
        }
      }

      const liveIssue = await this.fetchLiveIssue(item.id);
      provisioned.push({
        evidenceId: item.evidenceId,
        liveIssue
      });
    }

    return provisioned;
  }

  public async verifyProvisioningIssueProvenance(params: {
    readonly issueKeyOrId: string;
    readonly ecoIssueId: string;
    readonly ecoIssueKey: string;
    readonly projectKey: string;
    readonly templateId: import("../scenarios/industryTemplates").IndustryTemplateId;
    readonly evidenceId: string;
    readonly operationId: string;
  }): Promise<{ readonly jiraIssueId: string; readonly jiraIssueKey: string }> {
    const issue = await this.fetchLiveIssueByKeyOrId(params.issueKeyOrId);
    if (issue.projectKey !== params.projectKey) {
      throw new Error("Recovery candidate belongs to the wrong Jira project.");
    }
    const propRes = await this.requestJiraResilient(
      route`/rest/api/3/issue/${issue.issueId}/properties/linelock.provenance`,
      { headers: { Accept: "application/json" } }
    );
    if (!propRes.ok) {
      throw new Error("Recovery candidate has no LineLock provenance property.");
    }
    const prop = (await propRes.json()) as { readonly value?: Record<string, unknown> };
    const fields = {
      ecoIssueId: params.ecoIssueId,
      ecoIssueKey: params.ecoIssueKey,
      projectKey: params.projectKey,
      templateId: params.templateId,
      evidenceId: params.evidenceId,
      operationId: params.operationId
    };
    for (const [key, expected] of Object.entries(fields)) {
      if (prop.value?.[key] !== expected) {
        throw new Error(`Recovery candidate fails immutable LineLock provenance: ${key}.`);
      }
    }
    return { jiraIssueId: issue.issueId, jiraIssueKey: issue.issueKey };
  }

  /**
   * Idempotent per-slot completion with Jira-native provenance on the original
   * create request. A missing SQL checkpoint after an uncertain POST is deliberately
   * never retried automatically by the service.
   */
  public async provisionVerificationIssueSlot(params: {
    readonly projectKey: string;
    readonly ecoIssueKey: string;
    readonly ecoIssueId: string;
    readonly templateId: import("../scenarios/industryTemplates").IndustryTemplateId;
    readonly spec: VerificationIssueSeedSpec;
    readonly operationId: string;
    readonly stage?: import("./ports").EvidenceSlotStage;
    readonly existingIssueId?: string;
    readonly existingIssueKey?: string;
    readonly callbacks: import("./ports").CreateEvidenceSlotCallbacks;
  }): Promise<ProvisionedVerificationIssue> {
    const provenance = {
      ecoIssueId: params.ecoIssueId,
      ecoIssueKey: params.ecoIssueKey,
      projectKey: params.projectKey,
      templateId: params.templateId,
      evidenceId: params.spec.evidenceId,
      operationId: params.operationId
    };

    let issueId = params.existingIssueId ?? "";
    let issueKey = params.existingIssueKey ?? "";
    if (!issueId) {
      const issueTypeId = await this.resolveStandardIssueTypeId(params.projectKey);
      const createRes = await this.requestJiraResilient(route`/rest/api/3/issue`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            project: { key: params.projectKey },
            issuetype: { id: issueTypeId },
            summary: params.spec.summary,
            description: buildAdfDocument(params.spec.description)
          },
          properties: [{ key: "linelock.provenance", value: provenance }]
        })
      });
      if (!createRes.ok) {
        throw new Error(
          `Qualification issue creation failed for ${params.spec.evidenceId}: HTTP ${createRes.status}. The slot is marked uncertain until reviewed.`
        );
      }
      const created = (await createRes.json()) as { readonly id: string; readonly key: string };
      issueId = String(created.id);
      issueKey = created.key;
      // Persist Jira identity immediately, before any further Jira write.
      await params.callbacks.onCreated(issueId, issueKey);
    } else {
      // Never trust a user-entered issue ID or stale checkpoint without verifying
      // the atomically written Jira property and immutable parent identity.
      const propRes = await this.requestJiraResilient(
        route`/rest/api/3/issue/${issueId}/properties/linelock.provenance`
      );
      if (!propRes.ok) {
        throw new Error(`Cannot verify provenance for qualification issue ${issueId}.`);
      }
      const prop = (await propRes.json()) as { readonly value?: Record<string, unknown> };
      for (const [field, expected] of Object.entries(provenance)) {
        if (prop.value?.[field] !== expected) {
          throw new Error(`Qualification issue ${issueId} has mismatched provenance: ${field}.`);
        }
      }
    }

    const live = await this.fetchLiveIssue(issueId);
    if (live.statusCategoryKey.toLowerCase() !== "done") {
      await this.transitionIssueToDoneCategory(issueId);
    }
    await params.callbacks.onDone();

    const linksRes = await this.requestJiraResilient(
      route`/rest/api/3/issue/${issueId}?fields=issuelinks`,
      { headers: { Accept: "application/json" } }
    );
    if (!linksRes.ok) {
      throw new Error(`Cannot verify parent ECO link for qualification issue ${issueId}.`);
    }
    const linksBody = (await linksRes.json()) as {
      readonly fields?: {
        readonly issuelinks?: readonly {
          readonly inwardIssue?: { readonly id?: string; readonly key?: string };
          readonly outwardIssue?: { readonly id?: string; readonly key?: string };
        }[];
      };
    };
    const alreadyLinked = (linksBody.fields?.issuelinks ?? []).some(
      (link) => link.inwardIssue?.id === params.ecoIssueId ||
        link.outwardIssue?.id === params.ecoIssueId ||
        link.inwardIssue?.key === params.ecoIssueKey ||
        link.outwardIssue?.key === params.ecoIssueKey
    );
    if (!alreadyLinked) {
      const typeName = await this.resolveDefaultLinkTypeName();
      if (!typeName) {
        throw new Error("Jira issue linking is unavailable; qualification evidence is incomplete.");
      }
      const linkRes = await this.requestJiraResilient(route`/rest/api/3/issueLink`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          type: { name: typeName },
          inwardIssue: { key: issueKey || issueId },
          outwardIssue: { key: params.ecoIssueKey }
        })
      });
      if (!linkRes.ok) {
        throw new Error(
          `Jira refused the qualification link to ${params.ecoIssueKey}: HTTP ${linkRes.status}.`
        );
      }
    }
    await params.callbacks.onLinked();
    const complete = await this.fetchLiveIssue(issueId);
    if (complete.statusCategoryKey.toLowerCase() !== "done") {
      throw new Error(`Qualification issue ${issueId} is no longer in Done.`);
    }
    return { evidenceId: params.spec.evidenceId, liveIssue: complete };
  }

  public async postIssueComment(params: {
    readonly issueIdOrKey: string;
    readonly markdownText: string;
  }): Promise<{ readonly commentId: string }> {
    const res = await this.requestJiraResilient(
      route`/rest/api/3/issue/${params.issueIdOrKey}/comment`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          body: buildAuditCommentAdf(params.markdownText)
        })
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Failed posting Release Assurance comment to "${params.issueIdOrKey}": HTTP ${res.status} (${errText.slice(0, 180)})`
      );
    }

    const created = (await res.json()) as { readonly id?: string | number };
    return { commentId: String(created.id ?? "created") };
  }

  public async probeConnectivity(params: {
    readonly projectKey: string;
    readonly issueId: string;
  }): Promise<ConnectivityProbeResult> {
    const diagnostics: string[] = [];
    let callerAccountId: string | null = null;
    let callerDisplayName: string | null = null;
    let jiraServerBaseUrl: string | null = null;
    let jiraDeploymentType: string | null = null;
    let issueReachable = false;
    let resolvedRoleCount = 0;

    try {
      const myselfRes = await api.asUser().requestJira(route`/rest/api/3/myself`, {
        headers: { Accept: "application/json" }
      });
      if (myselfRes.ok) {
        const myself = (await myselfRes.json()) as JiraMyselfResponse;
        callerAccountId = myself.accountId ?? null;
        callerDisplayName = myself.displayName ?? null;
        diagnostics.push(`asUser(/rest/api/3/myself): HTTP 200 (${callerAccountId ?? "no-id"})`);
      } else {
        diagnostics.push(`asUser(/rest/api/3/myself): HTTP ${myselfRes.status}`);
      }
    } catch (err) {
      diagnostics.push(
        `asUser(/rest/api/3/myself) error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (callerAccountId) {
      const groups = await this.fetchUserGroupsSafe(callerAccountId);
      diagnostics.push(
        `resilient(/rest/api/3/user/groups): ${groups.length} group(s) resolved for caller`
      );
    }

    try {
      const infoRes = await this.requestJiraResilient(route`/rest/api/3/serverInfo`, {
        headers: { Accept: "application/json" }
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as JiraServerInfoResponse;
        jiraServerBaseUrl = info.baseUrl ?? null;
        jiraDeploymentType = info.deploymentType ?? null;
        diagnostics.push(
          `resilient(/rest/api/3/serverInfo): HTTP 200 (${jiraDeploymentType ?? "unknown"})`
        );
      } else {
        diagnostics.push(`resilient(/rest/api/3/serverInfo): HTTP ${infoRes.status}`);
      }
    } catch (err) {
      diagnostics.push(
        `resilient(/rest/api/3/serverInfo) error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      const issue = await this.fetchLiveIssue(params.issueId);
      issueReachable = true;
      diagnostics.push(
        `fetchLiveIssue(${params.issueId}): OK (${issue.issueKey}, statusCategory=${issue.statusCategoryKey})`
      );
    } catch (err) {
      diagnostics.push(
        `fetchLiveIssue(${params.issueId}) error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      const rolesRes = await this.requestJiraResilient(
        route`/rest/api/3/project/${params.projectKey}/role`,
        {
          headers: { Accept: "application/json" }
        }
      );
      if (rolesRes.ok) {
        const roleMap = (await rolesRes.json()) as Record<string, string>;
        resolvedRoleCount = Object.keys(roleMap).length;
        diagnostics.push(
          `resilient(/rest/api/3/project/${params.projectKey}/role): HTTP 200 (${resolvedRoleCount} project roles)`
        );
      } else {
        diagnostics.push(
          `resilient(/rest/api/3/project/${params.projectKey}/role): HTTP ${rolesRes.status}`
        );
      }
    } catch (err) {
      diagnostics.push(
        `projectRoleProbe(${params.projectKey}) error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const ok = Boolean(callerAccountId && jiraServerBaseUrl && issueReachable);

    return {
      ok,
      checkedAtEpochMs: Date.now(),
      callerAccountId,
      callerDisplayName,
      jiraServerBaseUrl,
      jiraDeploymentType,
      issueReachable,
      resolvedRoleCount,
      diagnostics
    };
  }

  private async fetchUserGroupsSafe(accountId: string): Promise<readonly JiraUserGroupItem[]> {
    try {
      const res = await this.requestJiraResilient(
        route`/rest/api/3/user/groups?accountId=${accountId}`,
        {
          headers: { Accept: "application/json" }
        }
      );
      if (!res.ok) {
        return [];
      }
      const parsed = (await res.json()) as unknown;
      return Array.isArray(parsed) ? (parsed as JiraUserGroupItem[]) : [];
    } catch {
      return [];
    }
  }

  private async resolveStandardIssueTypeId(projectKey: string): Promise<string> {
    const projRes = await this.requestJiraResilient(route`/rest/api/3/project/${projectKey}`, {
      headers: { Accept: "application/json" }
    });

    if (!projRes.ok) {
      throw new Error(
        `Unable to inspect issue types for project "${projectKey}": HTTP ${projRes.status}`
      );
    }

    const proj = (await projRes.json()) as JiraProjectDetailsResponse;
    const nonSubtasks = (proj.issueTypes ?? []).filter((t) => !t.subtask);
    const preferred =
      nonSubtasks.find((t) => t.name.toLowerCase() === "task") ??
      nonSubtasks.find((t) => t.name.toLowerCase() === "story") ??
      nonSubtasks[0];

    if (!preferred) {
      throw new Error(`No standard non-subtask issue type found in project "${projectKey}".`);
    }
    return preferred.id;
  }

  private async transitionIssueToDoneCategory(issueId: string): Promise<void> {
    const transRes = await this.requestJiraResilient(
      route`/rest/api/3/issue/${issueId}/transitions`,
      {
        headers: { Accept: "application/json" }
      }
    );

    if (!transRes.ok) {
      throw new Error(
        `Cannot inspect available transitions for qualification issue ${issueId}: HTTP ${transRes.status}.`
      );
    }

    const body = (await transRes.json()) as JiraTransitionsResponse;
    const doneTransition = (body.transitions ?? []).find(
      (t) => t.to?.statusCategory?.key?.toLowerCase() === "done"
    );
    if (!doneTransition) {
      throw new Error(
        `Qualification issue ${issueId} has no direct transition to Done. Configure a valid workflow or complete the necessary intermediate transitions manually.`
      );
    }

    const postRes = await this.requestJiraResilient(route`/rest/api/3/issue/${issueId}/transitions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        transition: { id: doneTransition.id }
      })
    });
    if (!postRes.ok) {
      throw new Error(
        `Jira refused the Done transition for qualification issue ${issueId}: HTTP ${postRes.status}.`
      );
    }
    const live = await this.fetchLiveIssue(issueId);
    if (live.statusCategoryKey.toLowerCase() !== "done") {
      throw new Error(
        `Jira accepted the transition request but qualification issue ${issueId} is still ${live.statusCategoryKey}, not Done.`
      );
    }
  }

  private async resolveDefaultLinkTypeName(): Promise<string | null> {
    try {
      const res = await this.requestJiraResilient(route`/rest/api/3/issueLinkType`, {
        headers: { Accept: "application/json" }
      });
      if (!res.ok) return null;
      const body = (await res.json()) as JiraIssueLinkTypesResponse;
      const types = body.issueLinkTypes ?? [];
      const relates = types.find((t) => t.name.toLowerCase().includes("relat"));
      return relates?.name ?? types[0]?.name ?? null;
    } catch {
      return null;
    }
  }
}
