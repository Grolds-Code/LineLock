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
          "Quality Approvers": "https://helios-industrial.atlassian.net/rest/api/3/project/ECO/role/10003"
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

    return { ok: false, status: 404, json: async () => ({}) };
  });

  return {
    default: {
      asApp: () => ({ requestJira: mockRequestJira }),
      asUser: () => ({ requestJira: mockRequestJira })
    },
    route: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      value: strings.reduce((acc, str, idx) => acc + str + (values[idx] !== undefined ? String(values[idx]) : ""), "")
    })
  };
});

import { ForgeJiraPlatformGateway } from "../src/forge/jiraGateway.js";

describe("ForgeJiraPlatformGateway — @forge/api REST Contract", () => {
  it("executes connectivity probe, parses ADF issue descriptions, and resolves project role actors", async () => {
    const gateway = new ForgeJiraPlatformGateway();

    const probe = await gateway.probeConnectivity({
      projectKey: "ECO",
      issueId: "20204"
    });
    expect(probe.ok).toBe(true);
    expect(probe.callerAccountId).toBe("5b10ac8d82e05b22cc7d4ef5");
    expect(probe.jiraServerBaseUrl).toBe("https://helios-industrial.atlassian.net");
    expect(probe.issueReachable).toBe(true);
    expect(probe.resolvedRoleCount).toBe(2);

    const issue = await gateway.fetchLiveIssue("20204");
    expect(issue.issueKey).toBe("ECO-204");
    expect(issue.description).toBe("Effectivity-scoped HV capacitor ECO.");
    expect(issue.statusCategoryKey).toBe("indeterminate");

    const roles = await gateway.fetchProjectRoleMembers("ECO", [
      "Lead Engineers",
      "Quality Approvers",
      "Nonexistent Role"
    ]);
    expect(roles["Lead Engineers"]).toEqual(["acct-lead-eng-1"]);
    expect(roles["Quality Approvers"]).toEqual(["acct-qa-approver-1"]);
    expect(roles["Nonexistent Role"]).toEqual([]);
  });
});
