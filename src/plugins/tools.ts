import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { OpenClawPluginToolContext } from "./types.js";

const log = createSubsystemLogger("plugins");

type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
  sourceKind: "plugin" | "mcp";
  mcpServer?: string;
  mcpTool?: string;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

type NormalizedAllowlist = {
  raw: string[];
  set: Set<string>;
};

function normalizeAllowlist(list?: string[]): NormalizedAllowlist {
  const raw = (list ?? []).map(normalizeToolName).filter(Boolean);
  return { raw, set: new Set(raw) };
}

function resolveOptionalMcpPolicyNames(params: {
  pluginId: string;
  toolName: string;
  mcpServer?: string;
  mcpTool?: string;
}): string[] {
  const names: string[] = [];
  const inferredMcpServer = params.pluginId.startsWith("mcp:")
    ? params.pluginId.slice(4).trim()
    : undefined;
  const mcpServer = normalizeToolName(params.mcpServer ?? inferredMcpServer ?? "");
  const mcpTool = normalizeToolName(params.mcpTool ?? params.toolName);
  if (mcpTool) {
    names.push(mcpTool);
  }
  if (mcpServer) {
    names.push(mcpServer);
    if (mcpTool) {
      names.push(`${mcpServer}/${mcpTool}`);
    }
  }
  return Array.from(new Set(names));
}

function createAllowByPatternMatcher(list: string[]): (name: string) => boolean {
  const compiled = compileGlobPatterns({
    raw: list,
    normalize: normalizeToolName,
  });
  if (compiled.length === 0) {
    return () => false;
  }
  return (name: string) => matchesAnyGlobPattern(normalizeToolName(name), compiled);
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: NormalizedAllowlist;
  allowByPattern: (name: string) => boolean;
  sourceKind?: "plugin" | "mcp";
  mcpServer?: string;
  mcpTool?: string;
}): boolean {
  if (params.allowlist.raw.length === 0) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (params.allowlist.set.has(toolName)) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.set.has(pluginKey)) {
    return true;
  }
  if (params.allowlist.set.has("group:plugins")) {
    return true;
  }
  if (params.allowByPattern(toolName)) {
    return true;
  }
  if (params.allowByPattern(pluginKey)) {
    return true;
  }
  const mcpPolicyNames =
    params.sourceKind === "mcp" || Boolean(params.mcpServer) || params.pluginId.startsWith("mcp:")
      ? resolveOptionalMcpPolicyNames({
          pluginId: params.pluginId,
          toolName,
          mcpServer: params.mcpServer,
          mcpTool: params.mcpTool,
        })
      : [];
  for (const policyName of mcpPolicyNames) {
    if (params.allowlist.set.has(policyName)) {
      return true;
    }
    if (params.allowByPattern(policyName)) {
      return true;
    }
  }
  return false;
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const effectiveConfig = applyTestPluginDefaults(params.context.config ?? {}, process.env);
  const normalized = normalizePluginsConfig(effectiveConfig.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const registry = loadOpenClawPlugins({
    config: effectiveConfig,
    workspaceDir: params.context.workspaceDir,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
      debug: (msg) => log.debug(msg),
    },
  });

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const allowByPattern = createAllowByPatternMatcher(allowlist.raw);
  const blockedPlugins = new Set<string>();

  for (const entry of registry.tools) {
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      log.error(message);
      registry.diagnostics.push({
        level: "error",
        pluginId: entry.pluginId,
        source: entry.source,
        message,
      });
      blockedPlugins.add(entry.pluginId);
      continue;
    }
    let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
    try {
      resolved = entry.factory(params.context);
    } catch (err) {
      log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      continue;
    }
    if (!resolved) {
      continue;
    }
    const listRaw = Array.isArray(resolved) ? resolved : [resolved];
    const list = entry.optional
      ? listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: tool.name,
            pluginId: entry.pluginId,
            allowlist,
            allowByPattern,
            sourceKind: entry.sourceKind,
            mcpServer: entry.mcpServer,
            mcpTool: entry.mcpTool,
          }),
        )
      : listRaw;
    if (list.length === 0) {
      continue;
    }
    const nameSet = new Set<string>();
    for (const tool of list) {
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        log.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
      nameSet.add(tool.name);
      existing.add(tool.name);
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        optional: entry.optional,
        sourceKind: entry.sourceKind === "mcp" ? "mcp" : "plugin",
        mcpServer: entry.mcpServer,
        mcpTool: entry.mcpTool,
      });
      tools.push(tool);
    }
  }

  return tools;
}
