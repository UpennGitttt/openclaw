import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.js";

const buildAgentSystemPromptMock = vi.hoisted(() => vi.fn((_: unknown) => "PROMPT"));
const resolveBootstrapContextForRunMock = vi.hoisted(() =>
  vi.fn(async (_: unknown) => ({ bootstrapFiles: [], contextFiles: [] })),
);
const createOpenClawCodingToolsMock = vi.hoisted(() => vi.fn((_: unknown) => []));
const resolveSandboxRuntimeStatusMock = vi.hoisted(() =>
  vi.fn((_: unknown) => ({ mode: "off", sandboxed: false })),
);
const buildSystemPromptParamsMock = vi.hoisted(() =>
  vi.fn((_: unknown) => ({
    runtimeInfo: {},
    userTimezone: undefined,
    userTime: undefined,
    userTimeFormat: undefined,
  })),
);
const resolveDefaultModelForAgentMock = vi.hoisted(() =>
  vi.fn((_: unknown) => ({ provider: "openai", model: "gpt-5" })),
);

vi.mock("../../agents/system-prompt.js", () => ({
  buildAgentSystemPrompt: (params: unknown) => buildAgentSystemPromptMock(params),
}));

vi.mock("../../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: (params: unknown) => resolveBootstrapContextForRunMock(params),
}));

vi.mock("../../agents/pi-tools.js", () => ({
  createOpenClawCodingTools: (params: unknown) => createOpenClawCodingToolsMock(params),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: (params: unknown) => resolveSandboxRuntimeStatusMock(params),
}));

vi.mock("../../agents/system-prompt-params.js", () => ({
  buildSystemPromptParams: (params: unknown) => buildSystemPromptParamsMock(params),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: (params: unknown) => resolveDefaultModelForAgentMock(params),
}));

function buildParams(cfg: OpenClawConfig, sessionKey: string): HandleCommandsParams {
  return {
    ctx: {
      Body: "/context",
      CommandBody: "/context",
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "whatsapp",
      Surface: "whatsapp",
    } as never,
    cfg,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      rawBodyNormalized: "/context",
      commandBodyNormalized: "/context",
    },
    directives: parseInlineDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey,
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("resolveCommandsSystemPromptBundle", () => {
  beforeEach(() => {
    buildAgentSystemPromptMock.mockClear();
    resolveBootstrapContextForRunMock.mockClear();
    createOpenClawCodingToolsMock.mockClear();
    resolveSandboxRuntimeStatusMock.mockClear();
    buildSystemPromptParamsMock.mockClear();
    resolveDefaultModelForAgentMock.mockClear();
  });

  it("passes default systemPromptMode and systemPrompt into builder", async () => {
    const cfg = {
      agents: {
        defaults: {
          systemPrompt: "default system prompt",
          systemPromptMode: "replace",
        },
      },
    } as OpenClawConfig;

    const result = await resolveCommandsSystemPromptBundle(buildParams(cfg, "agent:main:main"));
    expect(result.systemPrompt).toBe("PROMPT");
    expect(buildAgentSystemPromptMock).toHaveBeenCalled();
    const promptParams = buildAgentSystemPromptMock.mock.calls.at(-1)?.[0] as {
      agentSystemPrompt?: string;
      agentSystemPromptMode?: string;
    };
    expect(promptParams.agentSystemPrompt).toBe("default system prompt");
    expect(promptParams.agentSystemPromptMode).toBe("replace");
  });

  it("uses per-agent systemPromptMode and systemPrompt overrides", async () => {
    const cfg = {
      agents: {
        defaults: {
          systemPrompt: "default system prompt",
          systemPromptMode: "replace",
        },
        list: [
          {
            id: "coding",
            systemPrompt: "coding system prompt",
            systemPromptMode: "append",
          },
        ],
      },
    } as OpenClawConfig;

    const result = await resolveCommandsSystemPromptBundle(buildParams(cfg, "agent:coding:main"));
    expect(result.systemPrompt).toBe("PROMPT");
    const promptParams = buildAgentSystemPromptMock.mock.calls.at(-1)?.[0] as {
      agentSystemPrompt?: string;
      agentSystemPromptMode?: string;
    };
    expect(promptParams.agentSystemPrompt).toBe("coding system prompt");
    expect(promptParams.agentSystemPromptMode).toBe("append");
  });
});
