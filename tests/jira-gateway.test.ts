import { describe, expect, it, vi } from "vitest";

vi.mock("@forge/api", () => {
  const mockRequestJira = vi.fn(async (pathObj: { value?: string } | string) => {
    const pathStr = typeof pathObj === "string" ? pathObj : (pathObj.value ?? String(pathObj));

    if (pathStr.includes("/rest/api/3/myself")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accountId: "5b10ac8d82e05b22cc7d4ef5",
          displayName: "Principal Verification Engineer"
        })
      };
    }

    if (pathStr.includes("/rest/api/3/serverInfo")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          baseUrl: "https://helios-industrial.atlassian.net",
          deploymentType: "Cloud"
        })
      };
    }

    if (pathStr.includes("/rest/api/3/issue/20204")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "20204",
          key: "ECO-204",
          fields: {
            summary: "Substitute CAP-1210@C from SN 5000",
            description: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Effectivity-scoped HV capacitor ECO." }]
                }
              ]
            },
            updated: "2026-11-21T12:00:00.000Z",
            status: { statusCategory: { key: "indeterminate" } },
            resolution: null
          }
        })
      };
    }

    if (pathStr.endsWith("/rest/api/3/project/ECO/role")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          "Lead Engineers": "https://helios-industrial.atlassian.net/rest/api/3/project/ECO/role/10002",
          "Quality Approvers": "https://helios-industrial.atlassian.net/rest/api/3/project/ECO/role/10003",
          Administrators: "https://helios-industrial.atlassian.net/rest/api/3/project/ECO/role/10004"
        })
      };
    }

    if (pathStr.endsWith("/rest/api/3/project/ECO/role/10002")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          actors: [{ actorUser: { accountId: "acct-lead-eng-1" } }]
        })
      };
    }

    if (pathStr.endsWith("/rest/api/3/project/ECO/role/10003")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          actors: [{ actorUser: { accountId: "acct-qa-approver-1" } }]
        })
      };
    }

    if (pathStr.endsWith("/rest/api/3/project/ECO/role/10004")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          actors: [
            {
              type: "atlassian-group-role-actor",
              name: "jira-administrators",
              actorGroup: {
                groupId: "grp-admins-001",
                name: "jira-administrators",
                displayName: "jira-administrators"
              }
            }
          ]
        })
      };
    }

    if (pathStr.includes("/rest/api/3/user/groups?accountId=acct-group-admin-lead")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ groupId: "grp-admins-001", name: "jira-administrators" }]
      };
    }

    if (pathStr.includes("/rest/api/3/user/groups?accountId=acct-regular-user")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ groupId: "grp-users-001", name: "jira-software-users" }]
      };
    }

    if (pathStr.endsWith("/rest/api/3/issue/ECO-204/comment")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: "77881" })
      };
    }

    return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
  });

  let simulateAsAppUnavailableToken = false;

  return {
    __setSimulateAsAppUnavailableToken: (v: boolean) => {
      simulateAsAppUnavailableToken = v;
    },
    default: {
      asApp: () => ({
        requestJira: async (pathObj: { value?: string } | string) => {
          if (simulateAsAppUnavailableToken) {
            throw new Error(
              "PROXY_ERR: Forge platform failed to process runtime HTTP request - 500 - UNAVAILABLE_TOKEN_ERROR"
            );
          }
          return mockRequestJira(pathObj);
        }
      }),
      asUser: () => ({ requestJira: mockRequestJira })
    },
    route: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      value: strings.reduce((acc, str, idx) => acc + str + (values[idx] !== undefined ? String(values[idx]) : ""), "")
    })
  };
});

import * as mockedForgeApi from "@forge/api";
import { ForgeJiraPlatformGateway } from "../src/forge/jiraGateway";

describe("ForgeJiraPlatformGateway — @forge/api REST Contract", () => {
  it("executes connectivity probe, parses ADF issue descriptions, resolves direct + group role actors, and posts ADF audit comments", async () => {
    const gateway = new ForgeJiraPlatformGateway();

    const probe = await gateway.probeConnectivity({
      projectKey: "ECO",
      issueId: "20204"
    });
    expect(probe.ok).toBe(true);
    expect(probe.callerAccountId).toBe("5b10ac8d82e05b22cc7d4ef5");
    expect(probe.jiraServerBaseUrl).toBe("https://helios-industrial.atlassian.net");
    expect(probe.issueReachable).toBe(true);
    expect(probe.resolvedRoleCount).toBe(3);

    const issue = await gateway.fetchLiveIssue("20204");
    expect(issue.issueKey).toBe("ECO-204");
    expect(issue.description).toBe("Effectivity-scoped HV capacitor ECO.");
    expect(issue.statusCategoryKey).toBe("indeterminate");

    const roles = await gateway.fetchProjectRoleMembers(
      "ECO",
      ["Lead Engineers", "Quality Approvers", "Administrators", "Nonexistent Role"],
      ["acct-group-admin-lead", "acct-regular-user"]
    );
    expect(roles["Lead Engineers"]).toEqual(["acct-lead-eng-1"]);
    expect(roles["Quality Approvers"]).toEqual(["acct-qa-approver-1"]);
    expect(roles["Administrators"]).toEqual(["acct-group-admin-lead"]);
    expect(roles["Nonexistent Role"]).toEqual([]);

    const commentRes = await gateway.postIssueComment({
      issueIdOrKey: "ECO-204",
      markdownText: "# Audit Record\nVerified."
    });
    expect(commentRes.commentId).toBe("77881");
  });

  it("automatically recovers from Space/MCP asApp UNAVAILABLE_TOKEN_ERROR via asUser fallback", async () => {
    const ctl = mockedForgeApi as unknown as {
      __setSimulateAsAppUnavailableToken: (v: boolean) => void;
    };
    ctl.__setSimulateAsAppUnavailableToken(true);
    try {
      const gateway = new ForgeJiraPlatformGateway();
      const issue = await gateway.fetchLiveIssue("20204");
      expect(issue.issueKey).toBe("ECO-204");
      const roles = await gateway.fetchProjectRoleMembers(
        "ECO",
        ["Administrators"],
        ["acct-group-admin-lead"]
      );
      expect(roles["Administrators"]).toEqual(["acct-group-admin-lead"]);
    } finally {
      ctl.__setSimulateAsAppUnavailableToken(false);
    }
  });
});
