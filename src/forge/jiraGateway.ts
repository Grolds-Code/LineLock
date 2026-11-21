import api, { route } from "@forge/api";
import type { LiveJiraIssueProjection, ScalarValue } from "../core/types.js";
import type { ConnectivityProbeResult, JiraPlatformGateway } from "./ports.js";

interface JiraIssueRestResponse {
  readonly id: string;
  readonly key: string;
  readonly fields: {
    readonly summary?: string;
    readonly description?: unknown;
    readonly updated?: string;
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

interface JiraRoleDetailsResponse {
  readonly actors?: readonly {
    readonly actorUser?: {
      readonly accountId?: string;
    };
  }[];
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

/**
 * Minimal real Jira Cloud gateway using official `@forge/api` endpoints.
 * Requires only `read:jira-work` and `read:jira-user` scopes.
 */
export class ForgeJiraPlatformGateway implements JiraPlatformGateway {
  public async fetchLiveIssue(issueId: string): Promise<LiveJiraIssueProjection> {
    const res = await api
      .asApp()
      .requestJira(
        route`/rest/api/3/issue/${issueId}?fields=summary,description,status,resolution,updated`,
        { headers: { Accept: "application/json" } }
      );

    if (!res.ok) {
      throw new Error(`Jira REST fetch failed for issue "${issueId}": HTTP ${res.status}`);
    }

    const body = (await res.json()) as JiraIssueRestResponse;
    const updatedMs = body.fields.updated ? Date.parse(body.fields.updated) : 0;
    const structuredFields: Record<string, ScalarValue> = {};

    return {
      issueId: String(body.id),
      issueKey: body.key,
      summary: body.fields.summary ?? "",
      description: extractAdfPlainText(body.fields.description),
      statusCategoryKey: body.fields.status?.statusCategory?.key ?? "unknown",
      resolutionName: body.fields.resolution?.name ?? null,
      updatedAtEpochMs: Number.isFinite(updatedMs) ? updatedMs : 0,
      structuredFields
    };
  }

  public async fetchProjectRoleMembers(
    projectKey: string,
    requiredRoles: readonly string[]
  ): Promise<Record<string, readonly string[]>> {
    const rolesRes = await api
      .asApp()
      .requestJira(route`/rest/api/3/project/${projectKey}/role`, {
        headers: { Accept: "application/json" }
      });

    if (!rolesRes.ok) {
      throw new Error(
        `Jira REST role directory fetch failed for project "${projectKey}": HTTP ${rolesRes.status}`
      );
    }

    const roleUrlMap = (await rolesRes.json()) as Record<string, string>;
    const result: Record<string, readonly string[]> = {};

    for (const roleName of requiredRoles) {
      const roleUrl = roleUrlMap[roleName];
      if (!roleUrl) {
        result[roleName] = [];
        continue;
      }
      const match = /\/role\/(\d+)$/.exec(roleUrl);
      if (!match?.[1]) {
        result[roleName] = [];
        continue;
      }
      const roleId = match[1];
      const detailRes = await api
        .asApp()
        .requestJira(route`/rest/api/3/project/${projectKey}/role/${roleId}`, {
          headers: { Accept: "application/json" }
        });

      if (!detailRes.ok) {
        result[roleName] = [];
        continue;
      }

      const detail = (await detailRes.json()) as JiraRoleDetailsResponse;
      const accountIds = (detail.actors ?? [])
        .map((a) => a.actorUser?.accountId)
        .filter((id): id is string => Boolean(id));
      result[roleName] = [...new Set(accountIds)].sort();
    }

    return result;
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

    try {
      const infoRes = await api.asApp().requestJira(route`/rest/api/3/serverInfo`, {
        headers: { Accept: "application/json" }
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as JiraServerInfoResponse;
        jiraServerBaseUrl = info.baseUrl ?? null;
        jiraDeploymentType = info.deploymentType ?? null;
        diagnostics.push(
          `asApp(/rest/api/3/serverInfo): HTTP 200 (${jiraDeploymentType ?? "unknown"})`
        );
      } else {
        diagnostics.push(`asApp(/rest/api/3/serverInfo): HTTP ${infoRes.status}`);
      }
    } catch (err) {
      diagnostics.push(
        `asApp(/rest/api/3/serverInfo) error: ${err instanceof Error ? err.message : String(err)}`
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
      const rolesRes = await api
        .asApp()
        .requestJira(route`/rest/api/3/project/${params.projectKey}/role`, {
          headers: { Accept: "application/json" }
        });
      if (rolesRes.ok) {
        const roleMap = (await rolesRes.json()) as Record<string, string>;
        resolvedRoleCount = Object.keys(roleMap).length;
        diagnostics.push(
          `asApp(/rest/api/3/project/${params.projectKey}/role): HTTP 200 (${resolvedRoleCount} project roles)`
        );
      } else {
        diagnostics.push(
          `asApp(/rest/api/3/project/${params.projectKey}/role): HTTP ${rolesRes.status}`
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
}
