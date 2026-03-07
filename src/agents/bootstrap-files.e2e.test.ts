import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("uses agent promptContext.files to override default bootstrap file list", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const customPath = path.join(workspaceDir, "context", "coding.md");
    await fs.mkdir(path.dirname(customPath), { recursive: true });
    await fs.writeFile(customPath, "coding context", "utf-8");

    const cfg = {
      agents: {
        defaults: {
          promptContext: {
            files: ["AGENTS.md", "SOUL.md"],
          },
        },
        list: [
          {
            id: "coding",
            workspace: workspaceDir,
            promptContext: {
              files: ["context/coding.md"],
            },
          },
        ],
      },
    };

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      config: cfg,
      agentId: "coding",
    });
    expect(result.contextFiles.map((file) => file.path)).toEqual([customPath]);
    expect(result.contextFiles[0]?.content).toContain("coding context");
  });

  it("falls back to agents.defaults.promptContext.files when agent override is absent", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const defaultsPath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(defaultsPath, "agents context", "utf-8");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          promptContext: {
            files: ["AGENTS.md"],
          },
        },
      },
    };

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      config: cfg,
      agentId: "main",
    });
    expect(result.contextFiles.map((file) => file.path)).toEqual([defaultsPath]);
    expect(result.contextFiles[0]?.content).toContain("agents context");
  });

  it("supports explicit empty promptContext.files by injecting no files", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const cfg = {
      agents: {
        list: [
          {
            id: "coding",
            promptContext: {
              files: [],
            },
          },
        ],
      },
    };

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      config: cfg,
      agentId: "coding",
    });
    expect(result.contextFiles).toEqual([]);
  });

  it("still applies minimal bootstrap filtering for subagent sessions when promptContext.files is configured", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    const toolsPath = path.join(workspaceDir, "TOOLS.md");
    const customPath = path.join(workspaceDir, "context", "coding.md");
    await fs.mkdir(path.dirname(customPath), { recursive: true });
    await fs.writeFile(agentsPath, "agents context", "utf-8");
    await fs.writeFile(toolsPath, "tools context", "utf-8");
    await fs.writeFile(customPath, "custom context", "utf-8");

    const cfg = {
      agents: {
        list: [
          {
            id: "coding",
            workspace: workspaceDir,
            promptContext: {
              files: ["AGENTS.md", "TOOLS.md", "context/coding.md"],
            },
          },
        ],
      },
    };

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: cfg,
      sessionKey: "agent:coding:subagent:worker-1",
      agentId: "coding",
    });

    expect(files.map((file) => file.name).toSorted()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(files.some((file) => file.path === customPath)).toBe(false);
  });

  it("treats blank agentId as absent and still resolves configured prompt context", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const defaultsPath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(defaultsPath, "agents context", "utf-8");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          promptContext: {
            files: ["AGENTS.md"],
          },
        },
      },
    };

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      config: cfg,
      agentId: "   ",
    });
    expect(result.contextFiles.map((file) => file.path)).toEqual([defaultsPath]);
  });
});
