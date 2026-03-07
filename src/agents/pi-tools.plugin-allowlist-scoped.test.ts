import { beforeEach, describe, expect, it, vi } from "vitest";

const openclawToolMocks = vi.hoisted(() => ({
  createOpenClawTools: vi.fn(() => []),
}));

vi.mock("./openclaw-tools.js", () => ({
  createOpenClawTools: openclawToolMocks.createOpenClawTools,
}));

import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawCodingTools optional plugin bootstrap allowlist", () => {
  beforeEach(() => {
    openclawToolMocks.createOpenClawTools.mockClear();
  });

  it("includes scoped plugins/mcp allow entries when building optional plugin allowlist", () => {
    createOpenClawCodingTools({
      config: {
        tools: {
          policy: {
            plugins: { allow: ["optional_tool"] },
            mcp: { allow: ["github/search_repos"] },
          },
        },
      },
    });

    expect(openclawToolMocks.createOpenClawTools).toHaveBeenCalledOnce();
    const call = openclawToolMocks.createOpenClawTools.mock.calls[0]?.[0] as
      | { pluginToolAllowlist?: string[] }
      | undefined;
    expect(call?.pluginToolAllowlist ?? []).toEqual(
      expect.arrayContaining(["optional_tool", "github/search_repos"]),
    );
  });
});
