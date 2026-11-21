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

describe("Forge Manifest Official Schema & Handler Validation (@forge/manifest)", () => {
  it("validates manifest.yml with zero schema, scope, module, or file-reference errors and excludes Rovo/MCP bloat", async () => {
    const manifestPath = join(process.cwd(), "manifest.yml");
    const result = await validate(false, manifestPath);

    if (!result.success) {
      console.error("Manifest validation errors:", result.errors);
    }

    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);

    const typed = result.manifestObject?.typedContent as
      | { modules?: Record<string, unknown> }
      | undefined;
    expect(typed?.modules).toBeDefined();
    // Enforce vertical-slice discipline: no Rovo agent, MCP server, or action modules yet
    expect(typed?.modules?.["rovo:agent"]).toBeUndefined();
    expect(typed?.modules?.["action"]).toBeUndefined();
  });
});
