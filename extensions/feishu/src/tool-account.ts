import type { OpenClawConfig, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { resolveDefaultFeishuAccountId, resolveFeishuAccount } from "./accounts.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type FeishuToolKey = keyof FeishuToolsConfig;

export function resolveFeishuToolAccount(params: {
  cfg: OpenClawConfig;
  ctx?: OpenClawPluginToolContext;
}): ResolvedFeishuAccount | null {
  const accountId = params.ctx?.agentAccountId?.trim() || resolveDefaultFeishuAccountId(params.cfg);
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId });
  if (!account.enabled || !account.configured) {
    return null;
  }
  return account;
}

export function resolveFeishuToolContext(params: {
  cfg: OpenClawConfig;
  ctx?: OpenClawPluginToolContext;
  requiredTool?: FeishuToolKey;
}) {
  const account = resolveFeishuToolAccount(params);
  if (!account) {
    return null;
  }
  const toolsCfg = resolveToolsConfig(account.config.tools);
  if (params.requiredTool && !toolsCfg[params.requiredTool]) {
    return null;
  }
  return {
    account,
    toolsCfg,
    mediaMaxBytes: (account.config?.mediaMaxMb ?? 30) * 1024 * 1024,
  };
}
