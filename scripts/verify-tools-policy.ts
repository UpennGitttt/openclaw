import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentConfig } from "../src/agents/agent-scope.ts";
import { createOpenClawCodingTools } from "../src/agents/pi-tools.ts";
import { parseConfigJson5 } from "../src/config/config.ts";
import { loadOpenClawPlugins } from "../src/plugins/loader.ts";

type Config = {
  agents?: {
    defaults?: { model?: { primary?: string } };
  };
  tools?: {
    policy?: {
      tools?: { allow?: string[] };
      plugins?: { allow?: string[] };
      mcp?: { allow?: string[]; deny?: string[] };
    };
  };
};

function uniqSorted(items: Iterable<string>): string[] {
  return [...new Set([...items].filter(Boolean))].toSorted((a, b) => a.localeCompare(b));
}

function readConfig(configPath: string): Config {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok) {
    throw new Error(`failed to parse config (${configPath}): ${parsed.error}`);
  }
  return parsed.parsed as Config;
}

function classifyRuntimeTools(cfg: Config) {
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || process.cwd();
  const registry = loadOpenClawPlugins({
    config: cfg as never,
    workspaceDir,
    cache: false,
  });

  const pluginToolNames = new Set<string>();
  const mcpToolNames = new Set<string>();
  for (const tool of registry.tools) {
    const names = tool.names?.length ? tool.names : [];
    if (tool.sourceKind === "mcp") {
      for (const name of names) {
        mcpToolNames.add(name);
      }
    } else {
      for (const name of names) {
        pluginToolNames.add(name);
      }
    }
  }

  const runtimeCore = new Set<string>();
  const runtimePlugin = new Set<string>();
  const runtimeMcp = new Set<string>();

  for (const agentId of listAgentIds(cfg as never)) {
    const agentCfg = resolveAgentConfig(cfg as never, agentId) ?? {};
    const modelRaw =
      typeof agentCfg.model === "string"
        ? agentCfg.model
        : (agentCfg.model?.primary ?? cfg.agents?.defaults?.model?.primary ?? "");
    const [modelProvider, ...rest] = String(modelRaw).split("/");
    const modelId = rest.join("/") || undefined;

    const tools = createOpenClawCodingTools({
      config: cfg as never,
      sessionKey: `agent:${agentId}:main`,
      agentDir: agentCfg.agentDir,
      workspaceDir: agentCfg.workspace,
      modelProvider: modelProvider || undefined,
      modelId,
    });

    for (const tool of tools) {
      const name = tool.name;
      if (!name) {
        continue;
      }
      if (pluginToolNames.has(name)) {
        runtimePlugin.add(name);
      } else if (mcpToolNames.has(name)) {
        runtimeMcp.add(name);
      } else {
        runtimeCore.add(name);
      }
    }
  }

  return {
    core: uniqSorted(runtimeCore),
    plugins: uniqSorted(runtimePlugin),
    mcp: uniqSorted(runtimeMcp),
  };
}

function diff(expected: string[], actual: string[]) {
  const exp = new Set(expected);
  const act = new Set(actual);
  return {
    missing: uniqSorted(expected.filter((x) => !act.has(x))),
    extra: uniqSorted(actual.filter((x) => !exp.has(x))),
  };
}

function main() {
  const configPath =
    process.env.OPENCLAW_CONFIG || path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
  const cfg = readConfig(configPath);

  const policyCore = uniqSorted(cfg.tools?.policy?.tools?.allow ?? []);
  const policyPlugins = uniqSorted(cfg.tools?.policy?.plugins?.allow ?? []);
  const policyMcpAllow = uniqSorted(cfg.tools?.policy?.mcp?.allow ?? []);
  const policyMcpDeny = uniqSorted(cfg.tools?.policy?.mcp?.deny ?? []);

  const runtime = classifyRuntimeTools(cfg);

  const coreDiff = diff(policyCore, runtime.core);
  const pluginDiff = diff(policyPlugins, runtime.plugins);

  const mcpOk =
    runtime.mcp.length === 0
      ? policyMcpDeny.includes("*") || policyMcpAllow.length === 0
      : diff(policyMcpAllow, runtime.mcp).missing.length === 0;

  const ok =
    coreDiff.missing.length === 0 &&
    coreDiff.extra.length === 0 &&
    pluginDiff.missing.length === 0 &&
    pluginDiff.extra.length === 0 &&
    mcpOk;

  const report = {
    ok,
    configPath,
    runtime,
    policy: {
      core: policyCore,
      plugins: policyPlugins,
      mcpAllow: policyMcpAllow,
      mcpDeny: policyMcpDeny,
    },
    diff: {
      core: coreDiff,
      plugins: pluginDiff,
      mcp: {
        runtime: runtime.mcp,
        note:
          runtime.mcp.length === 0
            ? "runtime mcp empty; expect deny:[*] or empty mcp allowlist"
            : "runtime mcp non-empty; mcp allowlist should cover runtime tools",
      },
    },
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
