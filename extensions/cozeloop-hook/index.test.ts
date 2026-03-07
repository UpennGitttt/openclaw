import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

describe("cozeloop-hook plugin", () => {
  const hooks: Record<string, Function> = {};

  const api = {
    id: "cozeloop-hook",
    name: "Cozeloop Hook Exporter",
    config: {},
    pluginConfig: {
      apiToken: "pat_test",
      workspaceId: "ws_test",
      baseUrl: "https://api.coze.cn",
      timeoutMs: 5000,
      maxSerializedChars: 100000,
      llmOutputWaitMs: 0,
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    resolvePath: vi.fn((value: string) => value),
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("registers llm_input and agent_end hooks", () => {
    register(api as any);

    expect(api.on).toHaveBeenCalledWith("llm_input", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(api.logger.info).toHaveBeenCalledWith("cozeloop-hook: enabled");
  });

  it("reports two correlated spans on llm_input + agent_end", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-1",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-5",
        systemPrompt: "system",
        prompt: "hello",
        historyMessages: [{ role: "user", content: "hi" }],
        imagesCount: 0,
      },
      {
        agentId: "agent-a",
        sessionKey: "key-1",
        sessionId: "sess-1",
        workspaceDir: "/tmp/ws",
        messageProvider: "telegram",
      },
    );

    await hooks.agent_end(
      {
        messages: [{ role: "assistant", content: "done" }],
        success: true,
        durationMs: 120,
      },
      {
        agentId: "agent-a",
        sessionKey: "key-1",
        sessionId: "sess-1",
        workspaceDir: "/tmp/ws",
        messageProvider: "telegram",
      },
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const requestBody = JSON.parse(String((init as RequestInit).body)) as { spans: any[] };

    expect(requestBody.spans.length).toBeGreaterThanOrEqual(2);
    expect(requestBody.spans[0].span_name).toBe("agent-a.llm_input");
    expect(requestBody.spans[1].span_name).toBe("agent-a.agent_end");
    expect(requestBody.spans[0].span_type).toBe("model");
    expect(requestBody.spans[1].span_type).toBe("agent");
    expect(requestBody.spans[0].trace_id).toBe(requestBody.spans[1].trace_id);
    expect(requestBody.spans[1].parent_id).toBe(requestBody.spans[0].span_id);
    expect(requestBody.spans[0].tags_string.run_id).toBe("run-1");
    expect(requestBody.spans[1].tags_string.session_id).toBe("sess-1");
    expect(requestBody.spans[0].tags_string.agent_name).toBe("agent-a");
  });

  it("reports token usage on llm_output", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-usage",
        sessionId: "sess-usage",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-usage", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.llm_output(
      {
        runId: "run-usage",
        sessionId: "sess-usage",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["done"],
        usage: {
          input: 123,
          output: 45,
          total: 168,
          cacheRead: 7,
          cacheWrite: 8,
        },
      },
      { sessionId: "sess-usage", agentId: "agent-a", messageProvider: "feishu" },
    );
    await hooks.agent_end(
      {
        messages: [{ role: "assistant", content: "done" }],
        success: true,
        durationMs: 30,
      },
      { sessionId: "sess-usage", agentId: "agent-a", messageProvider: "feishu" },
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    expect(body.spans.length).toBeGreaterThanOrEqual(2);
    expect(body.spans[0].span_name).toBe("agent-a.llm_input");
    expect(body.spans[0].tags_long).toMatchObject({
      input_tokens: 123,
      inputTokens: 123,
      output_tokens: 45,
      outputTokens: 45,
      tokens: 168,
      totalTokens: 168,
      cache_read_tokens: 7,
      cacheReadTokens: 7,
      input_cached_tokens: 7,
      inputCachedTokens: 7,
      cache_write_tokens: 8,
      cacheWriteTokens: 8,
    });
    expect(body.spans[0].system_tags_long).toMatchObject({
      input_tokens: 123,
      output_tokens: 45,
      tokens: 168,
    });
    const endSpan = body.spans.find((span) => span.tags_string?.hook === "agent_end");
    expect(endSpan).toBeTruthy();
    expect(endSpan.tags_long?.input_tokens).toBeUndefined();
    expect(endSpan.tags_long?.output_tokens).toBeUndefined();
    expect(endSpan.tags_long?.tokens).toBeUndefined();
  });

  it("reports latencyFirstResp on llm span", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00.000Z"));
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-latency",
        sessionId: "sess-latency",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-latency", agentId: "agent-a", messageProvider: "feishu" },
    );

    vi.advanceTimersByTime(42);
    await hooks.llm_output(
      {
        runId: "run-latency",
        sessionId: "sess-latency",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["done"],
        usage: {
          input: 10,
          output: 5,
          total: 15,
        },
      },
      { sessionId: "sess-latency", agentId: "agent-a", messageProvider: "feishu" },
    );
    await hooks.agent_end(
      {
        messages: [{ role: "assistant", content: "done" }],
        success: true,
        durationMs: 80,
      },
      { sessionId: "sess-latency", agentId: "agent-a", messageProvider: "feishu" },
    );

    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const llmSpan = body.spans.find((span) => span.tags_string?.hook === "llm_input");
    expect(llmSpan).toBeTruthy();
    expect(llmSpan.tags_long).toMatchObject({
      latencyFirstResp: 42,
      latency_first_resp: 42,
      latency_first_resp_ms: 42,
      start_time_first_resp: expect.any(Number),
      startTimeFirstResp: expect.any(Number),
    });
    expect(llmSpan.system_tags_long).toMatchObject({
      latencyFirstResp: 42,
      latency_first_resp: 42,
      latency_first_resp_ms: 42,
      start_time_first_resp: expect.any(Number),
      startTimeFirstResp: expect.any(Number),
    });
  });

  it("reads usage aliases from llm_output.usage", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-usage-alias",
        sessionId: "sess-usage-alias",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-usage-alias", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.llm_output(
      {
        runId: "run-usage-alias",
        sessionId: "sess-usage-alias",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["done"],
        usage: {
          inputTokens: 222,
          outputTokens: 111,
          totalTokens: 333,
          cacheReadTokens: 5,
          cacheWriteTokens: 4,
        } as any,
      },
      { sessionId: "sess-usage-alias", agentId: "agent-a", messageProvider: "feishu" },
    );
    await hooks.agent_end(
      {
        messages: [{ role: "assistant", content: "done" }],
        success: true,
        durationMs: 30,
      },
      { sessionId: "sess-usage-alias", agentId: "agent-a", messageProvider: "feishu" },
    );

    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    expect(body.spans[0].tags_long).toMatchObject({
      input_tokens: 222,
      output_tokens: 111,
      tokens: 333,
      input_cached_tokens: 5,
    });
  });

  it("parses numeric-string usage fields", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-usage-string",
        sessionId: "sess-usage-string",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-usage-string", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.llm_output(
      {
        runId: "run-usage-string",
        sessionId: "sess-usage-string",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["done"],
        usage: {
          inputTokens: "210" as unknown as number,
          outputTokens: "90" as unknown as number,
          totalTokens: "300" as unknown as number,
        } as any,
      },
      { sessionId: "sess-usage-string", agentId: "agent-a", messageProvider: "feishu" },
    );
    await hooks.agent_end(
      {
        messages: [{ role: "assistant", content: "done" }],
        success: true,
        durationMs: 30,
      },
      { sessionId: "sess-usage-string", agentId: "agent-a", messageProvider: "feishu" },
    );

    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const llmSpan = body.spans.find((span) => span.tags_string?.hook === "llm_input");
    expect(llmSpan).toBeTruthy();
    expect(llmSpan.tags_long).toMatchObject({
      input_tokens: 210,
      output_tokens: 90,
      tokens: 300,
    });
  });

  it("correlates delayed llm_output after agent_end when wait window is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00.000Z"));
    register({
      ...api,
      pluginConfig: {
        ...api.pluginConfig,
        llmOutputWaitMs: 1000,
      },
    } as any);

    await hooks.llm_input(
      {
        runId: "run-delayed-output",
        sessionId: "sess-delayed-output",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-delayed-output", agentId: "agent-a", messageProvider: "feishu" },
    );

    const endPromise = hooks.agent_end(
      {
        messages: [{ role: "assistant", content: "fallback answer" }],
        success: true,
        durationMs: 80,
      },
      { sessionId: "sess-delayed-output", agentId: "agent-a", messageProvider: "feishu" },
    );

    await vi.advanceTimersByTimeAsync(120);
    await hooks.llm_output(
      {
        runId: "run-delayed-output",
        sessionId: "sess-delayed-output",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["done"],
        usage: {
          input: 12,
          output: 34,
          total: 46,
        },
      },
      { sessionId: "sess-delayed-output", agentId: "agent-a", messageProvider: "feishu" },
    );
    await endPromise;
    await vi.advanceTimersByTimeAsync(1000);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const llmSpan = body.spans.find((span) => span.tags_string?.hook === "llm_input");
    expect(llmSpan).toBeTruthy();
    expect(llmSpan.tags_long).toMatchObject({
      input_tokens: 12,
      output_tokens: 34,
      tokens: 46,
    });
  });

  it("prefers agent_end.runId correlation when multiple runs share one session", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-1",
        sessionId: "sess-shared",
        provider: "openai",
        model: "gpt-5",
        prompt: "first",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-shared", agentId: "agent-a", messageProvider: "feishu" },
    );
    await hooks.llm_input(
      {
        runId: "run-2",
        sessionId: "sess-shared",
        provider: "openai",
        model: "gpt-5",
        prompt: "second",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-shared", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.llm_output(
      {
        runId: "run-1",
        sessionId: "sess-shared",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["answer from run-1"],
        usage: { input: 11, output: 22, total: 33 },
      },
      { sessionId: "sess-shared", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.agent_end(
      {
        runId: "run-1",
        messages: [{ role: "assistant", content: "done run-1" }],
        success: true,
        durationMs: 30,
      },
      { sessionId: "sess-shared", agentId: "agent-a", messageProvider: "feishu" },
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const llmSpan = body.spans.find((span) => span.tags_string?.hook === "llm_input");
    expect(llmSpan).toBeTruthy();
    expect(llmSpan.tags_string.run_id).toBe("run-1");
    expect(llmSpan.tags_long).toMatchObject({
      input_tokens: 11,
      output_tokens: 22,
      tokens: 33,
    });
  });

  it("uses agent_end.runId in fallback ingest when llm_input is missing", async () => {
    register(api as any);

    await hooks.agent_end(
      {
        runId: "run-fallback-id",
        messages: [{ role: "assistant", content: "fallback only" }],
        success: true,
        durationMs: 20,
      },
      { sessionId: "sess-fallback-id", agentId: "agent-a", messageProvider: "feishu" },
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const endSpan = body.spans.find((span) => span.tags_string?.hook === "agent_end");
    expect(endSpan).toBeTruthy();
    expect(endSpan.tags_string.run_id).toBe("run-fallback-id");
  });

  it("falls back to assistant message usage when llm_output usage is missing", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-end-usage",
        sessionId: "sess-end-usage",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-end-usage", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.agent_end(
      {
        messages: [
          {
            role: "assistant",
            content: "done",
            usage: {
              inputTokens: 321,
              outputTokens: 123,
              totalTokens: 444,
            },
          },
        ],
        success: true,
        durationMs: 50,
      },
      { sessionId: "sess-end-usage", agentId: "agent-a", messageProvider: "feishu" },
    );

    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const llmSpan = body.spans.find((span) => span.tags_string?.hook === "llm_input");
    expect(llmSpan).toBeTruthy();
    expect(llmSpan.tags_long).toMatchObject({
      input_tokens: 321,
      inputTokens: 321,
      output_tokens: 123,
      outputTokens: 123,
      tokens: 444,
      totalTokens: 444,
    });
    const endSpan = body.spans.find((span) => span.tags_string?.hook === "agent_end");
    expect(endSpan).toBeTruthy();
    expect(endSpan.tags_long?.input_tokens).toBeUndefined();
    expect(endSpan.tags_long?.output_tokens).toBeUndefined();
    expect(endSpan.tags_long?.tokens).toBeUndefined();
    const llmOutput = JSON.parse(String(llmSpan.output)) as { assistantTexts?: string[] };
    expect(llmOutput.assistantTexts).toContain("done");
  });

  it("falls back to llm_output.lastAssistant text when assistantTexts is empty", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-last-assistant",
        sessionId: "sess-last-assistant",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-last-assistant", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.llm_output(
      {
        runId: "run-last-assistant",
        sessionId: "sess-last-assistant",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          content: [{ type: "text", text: "assistant from lastAssistant" }],
        },
      },
      { sessionId: "sess-last-assistant", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.agent_end(
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "fallback should not win" }] },
        ],
        success: true,
        durationMs: 40,
      },
      { sessionId: "sess-last-assistant", agentId: "agent-a", messageProvider: "feishu" },
    );

    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const llmSpan = body.spans.find((span) => span.tags_string?.hook === "llm_input");
    expect(llmSpan).toBeTruthy();
    const llmOutput = JSON.parse(String(llmSpan.output)) as { assistantTexts?: string[] };
    expect(llmOutput.assistantTexts).toEqual(["assistant from lastAssistant"]);
  });

  it("splits user/assistant/tool_call/tool_result into dedicated spans", async () => {
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-msg-split",
        sessionId: "sess-msg-split",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-msg-split", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.agent_end(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "question" }] },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: { cmd: "ls" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [{ type: "text", text: "tool output" }],
            isError: false,
          },
          { role: "assistant", content: [{ type: "text", text: "final answer" }] },
        ],
        success: true,
        durationMs: 60,
      },
      { sessionId: "sess-msg-split", agentId: "agent-a", messageProvider: "feishu" },
    );

    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    const names = body.spans.map((span) => span.span_name);
    expect(names).toContain("agent-a.msg.user");
    expect(names).toContain("agent-a.msg.assistant");
    expect(names).toContain("agent-a.tool_call");
    expect(names).toContain("agent-a.tool_result");
    const userSpan = body.spans.find((span) => span.span_name === "agent-a.msg.user");
    const assistantSpan = body.spans.find((span) => span.span_name === "agent-a.msg.assistant");
    expect(userSpan).toBeTruthy();
    expect(assistantSpan).toBeTruthy();
    expect(userSpan.span_type).toBe("user");
    expect(assistantSpan.span_type).toBe("assistant");

    const toolResultSpan = body.spans.find((span) => span.span_name === "agent-a.tool_result");
    expect(toolResultSpan).toBeTruthy();
    expect(toolResultSpan.output).toContain("tool output");
  });

  it("supports configurable span name strategy and span types", async () => {
    register({
      ...api,
      pluginConfig: {
        ...api.pluginConfig,
        spanNameMode: "fixed",
        spanNamePrefix: "my_agent",
        llmSpanType: "model",
        agentSpanType: "workflow",
      },
    } as any);

    await hooks.llm_input(
      {
        runId: "run-custom-span",
        sessionId: "sess-custom-span",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-custom-span", agentId: "agent-a", messageProvider: "feishu" },
    );

    await hooks.agent_end(
      {
        messages: [{ role: "assistant", content: "done" }],
        success: true,
        durationMs: 20,
      },
      { sessionId: "sess-custom-span", agentId: "agent-a", messageProvider: "feishu" },
    );

    const [, req] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((req as RequestInit).body)) as { spans: any[] };
    expect(body.spans.length).toBeGreaterThanOrEqual(2);
    expect(body.spans[0].span_name).toBe("my_agent.llm_input");
    expect(body.spans[1].span_name).toBe("my_agent.agent_end");
    expect(body.spans[0].span_type).toBe("model");
    expect(body.spans[1].span_type).toBe("workflow");
  });

  it("warns and skips when required auth config is missing", () => {
    register({
      ...api,
      pluginConfig: { workspaceId: "ws_only" },
    } as any);

    expect(api.on).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing apiToken/workspaceId"),
    );
  });

  it("logs warning when ingest fails", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("gateway", { status: 502 }),
    ) as unknown as typeof globalThis.fetch;
    register(api as any);

    await hooks.llm_input(
      {
        runId: "run-2",
        sessionId: "sess-2",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionId: "sess-2" },
    );

    await hooks.agent_end(
      {
        messages: [],
        success: false,
        error: "boom",
        durationMs: 10,
      },
      { sessionId: "sess-2" },
    );

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("cozeloop-hook: report failed"),
    );
  });
});
