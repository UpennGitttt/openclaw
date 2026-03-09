import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentPromptContextFiles,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
} from "./agent-scope.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForSession,
  loadPromptContextFiles,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const resolvedAgentId = resolveSessionAgentIds({
    agentId: params.agentId,
    sessionKey,
    config: params.config,
  }).sessionAgentId;

  // 如果有 agentId，优先使用 agent 专属 workspace（使用框架标准函数）
  let effectiveWorkspaceDir = params.workspaceDir;
  if (resolvedAgentId && params.config) {
    try {
      effectiveWorkspaceDir = resolveAgentWorkspaceDir(params.config, resolvedAgentId);
    } catch (error) {
      console.warn(
        `解析 agent workspace 失败，使用默认 workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const scopedPromptFiles =
    params.config && resolvedAgentId
      ? resolveAgentPromptContextFiles(params.config, resolvedAgentId)
      : undefined;

  const loadedBootstrapFiles =
    scopedPromptFiles !== undefined
      ? await loadPromptContextFiles(effectiveWorkspaceDir, scopedPromptFiles)
      : await loadWorkspaceBootstrapFiles(effectiveWorkspaceDir);
  const bootstrapFiles = filterBootstrapFilesForSession(loadedBootstrapFiles, sessionKey);

  return applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: effectiveWorkspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: resolvedAgentId,
  });
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
