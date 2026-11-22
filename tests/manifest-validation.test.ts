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
  it("validates manifest.yml with zero schema errors, zero external egress (Runs on Atlassian), and strictly GET read-only Rovo actions", async () => {
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
            "rovo:agent"?: readonly { key: string; actions?: readonly string[] }[];
            action?: readonly { key: string; actionVerb?: string }[];
          };
          permissions?: {
            external?: unknown;
          };
        }
      | undefined;

    expect(typed?.modules).toBeDefined();
    // Preserve Runs on Atlassian eligibility: zero external egress permissions
    expect(typed?.permissions?.external).toBeUndefined();

    // Verify Rovo agent exists and EVERY exposed Rovo action is strictly read-only (actionVerb: GET)
    expect(typed?.modules?.["rovo:agent"]).toHaveLength(1);
    const actions = typed?.modules?.action ?? [];
    expect(actions.length).toBe(3);
    for (const act of actions) {
      expect(act.actionVerb).toBe("GET");
    }
  }, 20_000);
});
