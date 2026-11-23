import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { validate } = require("@forge/manifest") as {
  validate: (
    basic?: boolean,
    manifestPath?: string
  ) => Promise<{
    success: boolean;
    errors?: readonly { message: string; line?: number; column?: number }[];
    manifestObject?: { typedContent?: Record<string, unknown> };
  }>;
};

describe("Forge Manifest Official Schema & Trust-Boundary Validation (@forge/manifest)", () => {
  it("validates manifest.yml with zero schema errors, zero external egress (Runs on Atlassian), projectPage, rovo:agent, and 4 strictly GET read-only Rovo actions", async () => {
    const manifestPath = join(process.cwd(), "manifest.yml");
    const result = await validate(false, manifestPath);

    if (!result.success) {
      console.error("Manifest validation errors:", result.errors);
    }

    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);

    const typed = result.manifestObject?.typedContent as
      | {
          modules?: {
            "jira:issuePanel"?: readonly { key: string }[];
            "jira:projectPage"?: readonly { key: string; layout?: string }[];
            "rovo:agent"?: readonly { key: string; actions?: readonly string[] }[];
            "rovo:mcp"?: unknown;
            action?: readonly { key: string; actionVerb?: string }[];
          };
          permissions?: {
            scopes?: readonly string[];
            external?: unknown;
          };
        }
      | undefined;

    expect(typed?.modules).toBeDefined();
    // Preserve Runs on Atlassian eligibility: zero external egress permissions
    expect(typed?.permissions?.external).toBeUndefined();
    expect(typed?.permissions?.scopes).toEqual([
      "storage:app",
      "read:jira-work",
      "write:jira-work",
      "read:jira-user"
    ]);

    // Verify space-wide Fleet Assurance project page + issue panel
    expect(typed?.modules?.["jira:issuePanel"]).toHaveLength(1);
    expect(typed?.modules?.["jira:projectPage"]).toHaveLength(1);
    expect(typed?.modules?.["jira:projectPage"]?.[0]?.key).toBe("ll-fleet-page");

    // Ensure rovo:mcp Preview is omitted so Jira-only installations (--product jira) never trigger UNAVAILABLE_TOKEN_ERROR
    expect(typed?.modules?.["rovo:mcp"]).toBeUndefined();

    // Verify Rovo agent exposes all 4 read-only GET actions
    expect(typed?.modules?.["rovo:agent"]).toHaveLength(1);
    expect(typed?.modules?.["rovo:agent"]?.[0]?.actions).toEqual([
      "ll-act-inspect-eco",
      "ll-act-sim-cutover",
      "ll-act-baselines",
      "ll-act-fleet-status"
    ]);

    const actions = typed?.modules?.action ?? [];
    expect(actions.length).toBe(4);
    for (const act of actions) {
      expect(act.actionVerb).toBe("GET");
    }
  }, 20_000);
});
