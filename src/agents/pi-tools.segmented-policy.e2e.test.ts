import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { __testing } from "./pi-tools.js";

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

describe("pi-tools segmented policy", () => {
  it("classifies MCP tools from explicit source metadata", () => {
    const tool = createStubTool("search");
    const classification = __testing.classifyToolForScopedPolicy(tool, {
      pluginId: "github-tools",
      optional: false,
      sourceKind: "mcp",
      mcpServer: "github",
      mcpTool: "search_repos",
    });

    expect(classification).toEqual({
      kind: "mcp",
      policyName: "github/search_repos",
    });
  });

  it("does not classify MCP by plugin id prefix without explicit MCP metadata", () => {
    const tool = createStubTool("search");
    const classification = __testing.classifyToolForScopedPolicy(tool, {
      pluginId: "mcp:slack",
      optional: false,
      sourceKind: "plugin",
    });

    expect(classification).toEqual({
      kind: "plugins",
    });
  });

  it("classifies MCP by mcp: prefix when compatibility inference is enabled", () => {
    const tool = createStubTool("search");
    const classification = __testing.classifyToolForScopedPolicy(
      tool,
      {
        pluginId: "mcp:slack",
        optional: false,
        sourceKind: "plugin",
      },
      { inferMcpFromPluginIdPrefix: true },
    );

    expect(classification).toEqual({
      kind: "mcp",
      policyName: "slack/search",
    });
  });

  it("applies tools/plugins/mcp policies independently by source kind", () => {
    const read = createStubTool("read");
    const exec = createStubTool("exec");
    const pluginTool = createStubTool("plugin_tool");
    const mcpTool = createStubTool("jira_search");

    const filtered = __testing.applyScopedToolPolicies({
      tools: [read, exec, pluginTool, mcpTool],
      classify: (tool) => {
        if (tool.name === "plugin_tool") {
          return { kind: "plugins" };
        }
        if (tool.name === "jira_search") {
          return { kind: "mcp", policyName: "jira/search" };
        }
        return { kind: "tools" };
      },
      policies: {
        tools: { allow: ["read"] },
        plugins: { allow: ["plugin_tool"] },
        mcp: { allow: ["jira/*"] },
      },
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["read", "plugin_tool", "jira_search"]);
  });

  it("resolves scoped policies with agent precedence over global", () => {
    const resolved = __testing.resolveScopedToolPolicies({
      cfg: {
        tools: {
          policy: {
            plugins: { allow: ["plugin_global"] },
          },
        },
        agents: {
          list: [
            {
              id: "coding",
              tools: {
                policy: {
                  plugins: { allow: ["plugin_agent"] },
                },
              },
            },
          ],
        },
      },
      agentId: "coding",
    });

    expect(resolved.plugins?.allow).toEqual(["plugin_agent"]);
  });
});
