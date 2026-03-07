import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config: agent promptContext/systemPrompt + scoped tool policy", () => {
  it("accepts agents.defaults and agents.list prompt context/system prompt config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          systemPrompt: "global system prompt",
          systemPromptMode: "replace",
          promptContext: {
            files: ["AGENTS.md", "docs/prompt/common.md"],
          },
        },
        list: [
          {
            id: "coding",
            systemPrompt: "coding system prompt",
            systemPromptMode: "append",
            promptContext: {
              files: [],
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts scoped tool policy for tools/plugins/mcp", () => {
    const res = validateConfigObject({
      tools: {
        policy: {
          tools: { profile: "coding", deny: ["gateway"] },
          plugins: { allow: ["group:plugins"] },
          mcp: { allow: ["github/*"], deny: ["slack/postMessage"] },
        },
      },
      agents: {
        list: [
          {
            id: "coding",
            tools: {
              policy: {
                plugins: { allow: ["my-plugin"] },
              },
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });
});
