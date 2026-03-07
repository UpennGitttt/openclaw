import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, resolvePluginTools } from "./tools.js";

type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  sourceKind?: "plugin" | "mcp";
  mcpServer?: string;
  mcpTool?: string;
  source: string;
  factory: (ctx: unknown) => unknown;
};

const loadOpenClawPluginsMock = vi.fn();

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (params: unknown) => loadOpenClawPluginsMock(params),
}));

function makeTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function createContext() {
  return {
    config: {
      plugins: {
        enabled: true,
        allow: ["optional-demo", "message", "multi"],
        load: { paths: ["/tmp/plugin.js"] },
      },
    },
    workspaceDir: "/tmp",
  };
}

function setRegistry(entries: MockRegistryToolEntry[]) {
  const registry = {
    tools: entries,
    diagnostics: [] as Array<{
      level: string;
      pluginId: string;
      source: string;
      message: string;
    }>,
  };
  loadOpenClawPluginsMock.mockReturnValue(registry);
  return registry;
}

describe("resolvePluginTools optional tools", () => {
  beforeEach(() => {
    loadOpenClawPluginsMock.mockReset();
  });

  it("skips optional tools without explicit allowlist", () => {
    setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => makeTool("optional_tool"),
      },
    ]);

    const tools = resolvePluginTools({
      context: createContext() as never,
    });

    expect(tools).toHaveLength(0);
  });

  it("allows optional tools by tool name", () => {
    setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => makeTool("optional_tool"),
      },
    ]);

    const tools = resolvePluginTools({
      context: createContext() as never,
      toolAllowlist: ["optional_tool"],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["optional_tool"]);
  });

  it("allows optional tools via plugin-scoped allowlist entries", () => {
    setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => makeTool("optional_tool"),
      },
    ]);

    const toolsByPlugin = resolvePluginTools({
      context: createContext() as never,
      toolAllowlist: ["optional-demo"],
    });
    const toolsByGroup = resolvePluginTools({
      context: createContext() as never,
      toolAllowlist: ["group:plugins"],
    });

    expect(toolsByPlugin.map((tool) => tool.name)).toEqual(["optional_tool"]);
    expect(toolsByGroup.map((tool) => tool.name)).toEqual(["optional_tool"]);
  });

  it("rejects plugin id collisions with core tool names", () => {
    const registry = setRegistry([
      {
        pluginId: "message",
        optional: false,
        source: "/tmp/message.js",
        factory: () => makeTool("optional_tool"),
      },
    ]);

    const tools = resolvePluginTools({
      context: createContext() as never,
      existingToolNames: new Set(["message"]),
    });

    expect(tools).toHaveLength(0);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.message).toContain("plugin id conflicts with core tool name");
  });

  it("skips conflicting tool names but keeps other tools", () => {
    const registry = setRegistry([
      {
        pluginId: "multi",
        optional: false,
        source: "/tmp/multi.js",
        factory: () => [makeTool("message"), makeTool("other_tool")],
      },
    ]);

    const tools = resolvePluginTools({
      context: createContext() as never,
      existingToolNames: new Set(["message"]),
    });

    expect(tools.map((tool) => tool.name)).toEqual(["other_tool"]);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.message).toContain("plugin tool name conflict");
  });

  it("attaches MCP source metadata to plugin tool entries", () => {
    setRegistry([
      {
        pluginId: "mcp:github",
        optional: false,
        sourceKind: "mcp",
        mcpServer: "github",
        mcpTool: "search_repos",
        source: "/tmp/mcp-github.js",
        factory: () => makeTool("search_repos"),
      },
    ]);

    const tools = resolvePluginTools({
      context: createContext() as never,
    });
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("expected plugin tool");
    }
    expect(getPluginToolMeta(tool)).toEqual({
      pluginId: "mcp:github",
      optional: false,
      sourceKind: "mcp",
      mcpServer: "github",
      mcpTool: "search_repos",
    });
  });

  it("allows optional MCP tools via scoped mcp server/tool allowlist entries", () => {
    setRegistry([
      {
        pluginId: "mcp:github",
        optional: true,
        sourceKind: "mcp",
        mcpServer: "github",
        mcpTool: "search_repos",
        source: "/tmp/mcp-github.js",
        factory: () => makeTool("search_repos"),
      },
    ]);

    const tools = resolvePluginTools({
      context: createContext() as never,
      toolAllowlist: ["github/search_repos"],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["search_repos"]);
  });

  it("allows optional MCP tools via wildcard mcp allowlist entries", () => {
    setRegistry([
      {
        pluginId: "mcp:github",
        optional: true,
        sourceKind: "mcp",
        mcpServer: "github",
        mcpTool: "search_repos",
        source: "/tmp/mcp-github.js",
        factory: () => makeTool("search_repos"),
      },
    ]);

    const tools = resolvePluginTools({
      context: createContext() as never,
      toolAllowlist: ["github/*"],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["search_repos"]);
  });
});
