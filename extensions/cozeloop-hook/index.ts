import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
} from "openclaw/plugin-sdk";

type CozeloopHookConfig = {
  enabled?: boolean;
  apiToken?: string;
  workspaceId?: string;
  baseUrl?: string;
  timeoutMs?: number;
  localLogPath?: string;
  maxSerializedChars?: number;
  spanNameMode?: "agent" | "fixed";
  spanNamePrefix?: string;
  llmSpanType?: string;
  agentSpanType?: string;
  llmOutputWaitMs?: number;
};

type UploadSpan = {
  started_at_micros: number;
  span_id: string;
  parent_id: string;
  trace_id: string;
  duration_micros: number;
  workspace_id: string;
  span_name: string;
  span_type: string;
  status_code: number;
  input: string;
  output: string;
  object_storage: string;
  system_tags_string?: Record<string, string>;
  system_tags_long?: Record<string, number>;
  tags_string?: Record<string, string>;
  tags_long?: Record<string, number>;
  tags_bool?: Record<string, boolean>;
};

type PendingRun = {
  runId: string;
  sessionId: string;
  traceId: string;
  llmSpanId: string;
  startedAtMs: number;
  outputAtMs?: number;
  inputEvent: PluginHookLlmInputEvent;
  hookContext: PluginHookAgentContext;
  outputEvent?: PluginHookLlmOutputEvent;
  outputContext?: PluginHookAgentContext;
  endEvent?: PluginHookAgentEndEvent;
  endContext?: PluginHookAgentContext;
  endAtMs?: number;
  finalizeTimer?: ReturnType<typeof setTimeout>;
  finalizing?: boolean;
};

type ResolvedConfig = {
  enabled: boolean;
  apiToken: string;
  workspaceId: string;
  baseUrl: string;
  timeoutMs: number;
  localLogPath?: string;
  maxSerializedChars: number;
  spanNameMode: "agent" | "fixed";
  spanNamePrefix: string;
  llmSpanType: string;
  agentSpanType: string;
  llmOutputWaitMs: number;
};

type CozeloopClient = {
  ingest: (spans: UploadSpan[]) => Promise<void>;
};

const DEFAULT_BASE_URL = "https://api.coze.cn";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_SERIALIZED_CHARS = 180_000;
const DEFAULT_LLM_OUTPUT_WAIT_MS = 1500;
const RUN_STALE_MS = 60 * 60 * 1000;
const TOOL_CALL_BLOCK_TYPES = new Set(["tooluse", "tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_BLOCK_TYPES = new Set(["toolresult", "tool_result", "tool_result_error"]);

function createHexId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = `... [truncated ${value.length - maxChars} chars]`;
  return value.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

function stringifySafe(value: unknown, maxChars: number): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, (_key, raw) => {
    if (typeof raw === "bigint") {
      return raw.toString();
    }
    if (raw && typeof raw === "object") {
      const obj = raw as object;
      if (seen.has(obj)) {
        return "[Circular]";
      }
      seen.add(obj);
    }
    return raw;
  });
  return truncateText(json ?? "null", maxChars);
}

function resolveConfig(api: OpenClawPluginApi): ResolvedConfig {
  const cfg = (api.pluginConfig ?? {}) as CozeloopHookConfig;
  const enabledRaw = cfg.enabled ?? process.env.COZELOOP_HOOK_ENABLED;
  const enabled =
    typeof enabledRaw === "boolean"
      ? enabledRaw
      : typeof enabledRaw === "string"
        ? enabledRaw.toLowerCase() !== "false"
        : true;
  const apiToken = (
    cfg.apiToken ??
    process.env.COZELOOP_API_TOKEN ??
    process.env.COZELOOP_PAT ??
    ""
  ).trim();
  const workspaceId = (
    cfg.workspaceId ??
    process.env.COZELOOP_WORKSPACE_ID ??
    process.env.COZE_WORKSPACE_ID ??
    ""
  ).trim();
  const baseUrl = trimTrailingSlash(
    (cfg.baseUrl ?? process.env.COZELOOP_BASE_URL ?? DEFAULT_BASE_URL).trim(),
  );
  const timeoutMs = Math.max(
    1000,
    toFiniteNumber(cfg.timeoutMs ?? process.env.COZELOOP_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
  );
  const maxSerializedChars = Math.max(
    2000,
    toFiniteNumber(cfg.maxSerializedChars ?? process.env.COZELOOP_MAX_SERIALIZED_CHARS) ??
      DEFAULT_MAX_SERIALIZED_CHARS,
  );
  const spanNameModeRaw = (cfg.spanNameMode ?? process.env.COZELOOP_SPAN_NAME_MODE ?? "agent")
    .toString()
    .trim()
    .toLowerCase();
  const spanNameMode: "agent" | "fixed" = spanNameModeRaw === "fixed" ? "fixed" : "agent";
  const spanNamePrefix =
    toNonEmptyString(cfg.spanNamePrefix ?? process.env.COZELOOP_SPAN_NAME_PREFIX) ?? "openclaw";
  const llmSpanType =
    toNonEmptyString(cfg.llmSpanType ?? process.env.COZELOOP_LLM_SPAN_TYPE) ?? "model";
  const agentSpanType =
    toNonEmptyString(cfg.agentSpanType ?? process.env.COZELOOP_AGENT_SPAN_TYPE) ?? "agent";
  const llmOutputWaitMs = Math.max(
    0,
    toFiniteNumber(cfg.llmOutputWaitMs ?? process.env.COZELOOP_LLM_OUTPUT_WAIT_MS) ??
      DEFAULT_LLM_OUTPUT_WAIT_MS,
  );

  return {
    enabled,
    apiToken,
    workspaceId,
    baseUrl,
    timeoutMs,
    maxSerializedChars,
    localLogPath: typeof cfg.localLogPath === "string" ? cfg.localLogPath : undefined,
    spanNameMode,
    spanNamePrefix,
    llmSpanType,
    agentSpanType,
    llmOutputWaitMs,
  };
}

function createClient(cfg: ResolvedConfig): CozeloopClient {
  return {
    async ingest(spans: UploadSpan[]): Promise<void> {
      if (spans.length === 0) {
        return;
      }
      const response = await fetch(`${cfg.baseUrl}/v1/loop/traces/ingest`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spans }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });

      const bodyText = await response.text();
      let body: { code?: number; msg?: string } | null = null;
      try {
        body = bodyText ? (JSON.parse(bodyText) as { code?: number; msg?: string }) : null;
      } catch {
        body = null;
      }

      if (!response.ok) {
        throw new Error(
          `cozeloop ingest failed (${response.status}): ${truncateText(bodyText, 600)}`,
        );
      }
      if (body && typeof body.code === "number" && body.code !== 0) {
        throw new Error(`cozeloop ingest rejected (${body.code}): ${body.msg ?? "unknown error"}`);
      }
    },
  };
}

async function appendLocalLog(logPath: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

function runKey(runId: string, sessionId: string): string {
  return `${runId}::${sessionId}`;
}

function normalizeUsage(value: unknown): Record<string, number> | undefined {
  const asLong = (input: unknown): number | undefined => {
    if (typeof input === "number" && Number.isFinite(input)) {
      return Math.max(0, Math.floor(input));
    }
    if (typeof input === "string" && input.trim()) {
      const parsed = Number(input);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
    }
    return undefined;
  };
  const usage =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const inputMaybe = asLong(
    usage.input ??
      usage.inputTokens ??
      usage.input_tokens ??
      usage.promptTokens ??
      usage.prompt_tokens,
  );
  const outputMaybe = asLong(
    usage.output ??
      usage.outputTokens ??
      usage.output_tokens ??
      usage.completionTokens ??
      usage.completion_tokens,
  );
  const totalMaybe = asLong(usage.total ?? usage.totalTokens ?? usage.total_tokens);
  const cacheReadMaybe = asLong(
    usage.cacheRead ??
      usage.cache_read ??
      usage.inputCached ??
      usage.input_cached ??
      usage.inputCachedTokens ??
      usage.input_cached_tokens ??
      usage.cacheReadTokens ??
      usage.cache_read_tokens ??
      usage.cache_read_input_tokens,
  );
  const cacheWriteMaybe = asLong(
    usage.cacheWrite ??
      usage.cache_write ??
      usage.cacheWriteTokens ??
      usage.cache_write_tokens ??
      usage.cache_creation_input_tokens,
  );
  if (
    inputMaybe === undefined &&
    outputMaybe === undefined &&
    totalMaybe === undefined &&
    cacheReadMaybe === undefined &&
    cacheWriteMaybe === undefined
  ) {
    return undefined;
  }
  const inputTokens = inputMaybe ?? 0;
  const outputTokens = outputMaybe ?? 0;
  const totalTokens = totalMaybe ?? inputTokens + outputTokens;
  const cacheReadTokens = cacheReadMaybe ?? 0;
  const cacheWriteTokens = cacheWriteMaybe ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    tokens: totalTokens,
    input_cached_tokens: cacheReadTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
  };
}

function findAssistantUsage(messages: unknown[] | undefined): unknown {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const record = msg as Record<string, unknown>;
    if (record.role === "assistant" && record.usage && typeof record.usage === "object") {
      return record.usage;
    }
  }
  return undefined;
}

function resolveUsage(params: {
  outputEvent?: PluginHookLlmOutputEvent;
  endEvent?: PluginHookAgentEndEvent;
}): Record<string, number> {
  return (
    normalizeUsage(params.outputEvent?.usage) ??
    normalizeUsage(
      params.outputEvent?.lastAssistant &&
        typeof params.outputEvent.lastAssistant === "object" &&
        "usage" in (params.outputEvent.lastAssistant as Record<string, unknown>)
        ? (params.outputEvent.lastAssistant as { usage?: unknown }).usage
        : undefined,
    ) ??
    normalizeUsage(findAssistantUsage(params.endEvent?.messages)) ?? {
      input_tokens: 0,
      output_tokens: 0,
      tokens: 0,
      input_cached_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    }
  );
}

function buildTokenTags(usageLong: Record<string, number>): Record<string, number> {
  const tokenTags: Record<string, number> = {};
  if (usageLong.input_tokens > 0) {
    tokenTags.input_tokens = usageLong.input_tokens;
    tokenTags.inputTokens = usageLong.input_tokens;
  }
  if (usageLong.output_tokens > 0) {
    tokenTags.output_tokens = usageLong.output_tokens;
    tokenTags.outputTokens = usageLong.output_tokens;
  }
  if (usageLong.tokens > 0) {
    tokenTags.tokens = usageLong.tokens;
    tokenTags.totalTokens = usageLong.tokens;
  }
  if (usageLong.input_cached_tokens > 0) {
    tokenTags.input_cached_tokens = usageLong.input_cached_tokens;
    tokenTags.inputCachedTokens = usageLong.input_cached_tokens;
  }
  if (usageLong.cache_read_tokens > 0) {
    tokenTags.cache_read_tokens = usageLong.cache_read_tokens;
    tokenTags.cacheReadTokens = usageLong.cache_read_tokens;
  }
  if (usageLong.cache_write_tokens > 0) {
    tokenTags.cache_write_tokens = usageLong.cache_write_tokens;
    tokenTags.cacheWriteTokens = usageLong.cache_write_tokens;
  }
  return tokenTags;
}

function buildLatencyTags(params: {
  startedAtMs: number;
  outputAtMs?: number;
  durationMs?: number;
}): Record<string, number> {
  const asLong = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.floor(value));
  };
  const firstRespAtMsRaw =
    typeof params.outputAtMs === "number" && params.outputAtMs >= params.startedAtMs
      ? params.outputAtMs
      : typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
        ? params.startedAtMs + params.durationMs
        : undefined;
  const firstRespMsRaw =
    typeof firstRespAtMsRaw === "number" && firstRespAtMsRaw >= params.startedAtMs
      ? firstRespAtMsRaw - params.startedAtMs
      : undefined;
  const firstRespMs = asLong(firstRespMsRaw);
  if (firstRespMs <= 0) {
    return {};
  }
  const firstRespAtMicros = asLong(firstRespAtMsRaw) * 1000;
  return {
    latencyFirstResp: firstRespMs,
    latency_first_resp: firstRespMs,
    latency_first_resp_ms: firstRespMs,
    ...(firstRespAtMicros > 0
      ? {
          start_time_first_resp: firstRespAtMicros,
          startTimeFirstResp: firstRespAtMicros,
        }
      : {}),
  };
}

function sanitizeSpanPrefix(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "_");
  return normalized || "openclaw";
}

function buildSpanName(cfg: ResolvedConfig, agentName: string, phase: string): string {
  const baseName = cfg.spanNameMode === "fixed" ? cfg.spanNamePrefix : agentName;
  const prefix = sanitizeSpanPrefix(baseName);
  return `${prefix}.${phase}`;
}

function normalizeMessageRole(
  value: unknown,
): "user" | "assistant" | "tool" | "toolResult" | "unknown" {
  if (typeof value !== "string") {
    return "unknown";
  }
  const role = value.trim().toLowerCase();
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "tool") {
    return "tool";
  }
  if (role === "toolresult" || role === "tool_result") {
    return "toolResult";
  }
  return "unknown";
}

function normalizeBlockType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      if (entry.trim()) {
        parts.push(entry.trim());
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const text = block.text;
    if (typeof text === "string" && text.trim()) {
      parts.push(text.trim());
      continue;
    }
    const type = normalizeBlockType(block.type);
    if (type === "text") {
      const literal = block.literalString;
      if (typeof literal === "string" && literal.trim()) {
        parts.push(literal.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function extractToolCallsFromMessage(message: Record<string, unknown>): Array<{
  toolName: string;
  toolCallId: string;
  toolInput: unknown;
}> {
  const seen = new Set<string>();
  const calls: Array<{ toolName: string; toolCallId: string; toolInput: unknown }> = [];
  const push = (name: unknown, id: unknown, input: unknown) => {
    const toolName = typeof name === "string" && name.trim() ? name.trim() : "unknown_tool";
    const toolCallId = typeof id === "string" && id.trim() ? id.trim() : "";
    const key = `${toolName}::${toolCallId}::${JSON.stringify(input ?? null)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    calls.push({ toolName, toolCallId, toolInput: input });
  };

  const content = message.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const block = entry as Record<string, unknown>;
      const blockType = normalizeBlockType(block.type);
      if (!TOOL_CALL_BLOCK_TYPES.has(blockType)) {
        continue;
      }
      push(
        block.name,
        block.id ?? block.toolCallId ?? block.toolUseId,
        block.input ?? block.arguments ?? block.args,
      );
    }
  }

  const rawCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const callList = Array.isArray(rawCalls) ? rawCalls : rawCalls ? [rawCalls] : [];
  for (const raw of callList) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const call = raw as Record<string, unknown>;
    const fn =
      call.function && typeof call.function === "object"
        ? (call.function as Record<string, unknown>)
        : {};
    push(
      call.name ?? fn.name,
      call.id ?? call.toolCallId ?? call.toolUseId,
      call.arguments ?? fn.arguments ?? call.input,
    );
  }
  return calls;
}

function extractToolResultsFromMessage(message: Record<string, unknown>): Array<{
  toolCallId: string;
  text: string;
  isError: boolean;
}> {
  const role = normalizeMessageRole(message.role);
  const results: Array<{ toolCallId: string; text: string; isError: boolean }> = [];
  const push = (toolCallId: unknown, text: unknown, isError: unknown) => {
    const normalizedId =
      typeof toolCallId === "string" && toolCallId.trim() ? toolCallId.trim() : "";
    const normalizedText =
      typeof text === "string" && text.trim()
        ? text.trim()
        : text !== undefined && text !== null
          ? JSON.stringify(text)
          : "";
    const normalizedError = isError === true;
    results.push({ toolCallId: normalizedId, text: normalizedText, isError: normalizedError });
  };

  if (role === "toolResult") {
    push(
      message.toolCallId ?? message.toolUseId,
      extractTextFromContent(message.content),
      message.isError ?? message.is_error,
    );
    return results;
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return results;
  }
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const blockType = normalizeBlockType(block.type);
    if (!TOOL_RESULT_BLOCK_TYPES.has(blockType)) {
      continue;
    }
    const isError =
      blockType === "tool_result_error" || block.is_error === true || block.isError === true;
    push(block.toolCallId ?? block.id ?? block.toolUseId, block.text ?? block.content, isError);
  }
  return results;
}

function buildMessageDetailSpans(params: {
  cfg: ResolvedConfig;
  workspaceId: string;
  traceId: string;
  parentId: string;
  agentName: string;
  runId: string;
  sessionId: string;
  startedAtMicros: number;
  durationMicros: number;
  messages: unknown[];
}): UploadSpan[] {
  const detailSpans: UploadSpan[] = [];
  const msgRecords = params.messages.filter(
    (msg): msg is Record<string, unknown> => Boolean(msg) && typeof msg === "object",
  );
  if (msgRecords.length === 0) {
    return detailSpans;
  }

  const slotMicros = Math.max(
    1000,
    Math.floor(params.durationMicros / Math.max(1, msgRecords.length + 1)),
  );
  let slot = 1;
  for (const message of msgRecords) {
    const role = normalizeMessageRole(message.role);
    const text = extractTextFromContent(message.content);
    const spanStart = params.startedAtMicros + slot * slotMicros;
    slot += 1;

    if (role === "user" && text) {
      detailSpans.push(
        baseSpan({
          workspaceId: params.workspaceId,
          traceId: params.traceId,
          spanId: createHexId(8),
          parentId: params.parentId,
          spanName: buildSpanName(params.cfg, params.agentName, "msg.user"),
          spanType: "user",
          startedAtMicros: spanStart,
          durationMicros: slotMicros,
          statusCode: 0,
          input: truncateText(text, params.cfg.maxSerializedChars),
          output: "",
          tagsString: {
            hook: "agent_message",
            role: "user",
            run_id: params.runId,
            session_id: params.sessionId,
          },
        }),
      );
    }

    if (role === "assistant" && text) {
      detailSpans.push(
        baseSpan({
          workspaceId: params.workspaceId,
          traceId: params.traceId,
          spanId: createHexId(8),
          parentId: params.parentId,
          spanName: buildSpanName(params.cfg, params.agentName, "msg.assistant"),
          spanType: "assistant",
          startedAtMicros: spanStart,
          durationMicros: slotMicros,
          statusCode: 0,
          input: "",
          output: truncateText(text, params.cfg.maxSerializedChars),
          tagsString: {
            hook: "agent_message",
            role: "assistant",
            run_id: params.runId,
            session_id: params.sessionId,
          },
        }),
      );
    }

    const toolCalls = extractToolCallsFromMessage(message);
    for (const toolCall of toolCalls) {
      detailSpans.push(
        baseSpan({
          workspaceId: params.workspaceId,
          traceId: params.traceId,
          spanId: createHexId(8),
          parentId: params.parentId,
          spanName: buildSpanName(params.cfg, params.agentName, "tool_call"),
          spanType: "tool",
          startedAtMicros: spanStart,
          durationMicros: slotMicros,
          statusCode: 0,
          input: stringifySafe(
            {
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              input: toolCall.toolInput,
            },
            params.cfg.maxSerializedChars,
          ),
          output: "",
          tagsString: {
            hook: "tool_call",
            role: "assistant",
            tool_name: toolCall.toolName,
            tool_call_id: toolCall.toolCallId,
            run_id: params.runId,
            session_id: params.sessionId,
          },
        }),
      );
    }

    const toolResults = extractToolResultsFromMessage(message);
    for (const toolResult of toolResults) {
      detailSpans.push(
        baseSpan({
          workspaceId: params.workspaceId,
          traceId: params.traceId,
          spanId: createHexId(8),
          parentId: params.parentId,
          spanName: buildSpanName(params.cfg, params.agentName, "tool_result"),
          spanType: "tool",
          startedAtMicros: spanStart,
          durationMicros: slotMicros,
          statusCode: toolResult.isError ? -1 : 0,
          input: stringifySafe(
            {
              toolCallId: toolResult.toolCallId,
            },
            params.cfg.maxSerializedChars,
          ),
          output: truncateText(toolResult.text, params.cfg.maxSerializedChars),
          tagsString: {
            hook: "tool_result",
            role: role === "toolResult" ? "toolResult" : "assistant",
            tool_call_id: toolResult.toolCallId,
            run_id: params.runId,
            session_id: params.sessionId,
          },
          tagsBool: {
            error: toolResult.isError,
          },
        }),
      );
    }
  }
  return detailSpans;
}

function extractAssistantTextsFromMessages(messages: unknown[] | undefined): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (normalizeMessageRole(record.role) !== "assistant") {
      continue;
    }
    const text = extractTextFromContent(record.content);
    if (!text) {
      continue;
    }
    texts.push(text);
  }
  return texts;
}

function extractAssistantTextsFromLastAssistant(lastAssistant: unknown): string[] {
  if (!lastAssistant || typeof lastAssistant !== "object") {
    return [];
  }
  const record = lastAssistant as Record<string, unknown>;
  const role = normalizeMessageRole(record.role);
  if (role !== "assistant" && role !== "unknown") {
    return [];
  }
  const textFromContent = extractTextFromContent(record.content);
  if (textFromContent) {
    return [textFromContent];
  }
  if (typeof record.text === "string" && record.text.trim()) {
    return [record.text.trim()];
  }
  return [];
}

function resolveAgentName(api: OpenClawPluginApi, agentId?: string): string {
  const listRaw = api.config?.agents?.list;
  const list = Array.isArray(listRaw) ? listRaw : [];
  const selected =
    list.find((entry) => typeof entry.id === "string" && entry.id === agentId) ??
    list.find((entry) => entry.default === true) ??
    list[0];
  if (!selected) {
    return agentId ?? "";
  }
  const identity = selected.identity;
  const identityName =
    identity && typeof identity === "object" && typeof identity.name === "string"
      ? identity.name.trim()
      : "";
  const name = typeof selected.name === "string" ? selected.name.trim() : "";
  if (identityName) {
    return identityName;
  }
  if (name) {
    return name;
  }
  return typeof selected.id === "string" ? selected.id : (agentId ?? "");
}

function resolveRunIdFromAgentEnd(event: PluginHookAgentEndEvent): string | undefined {
  const record = event as Record<string, unknown>;
  const runIdRaw = record.runId;
  return typeof runIdRaw === "string" && runIdRaw.trim() ? runIdRaw.trim() : undefined;
}

function baseSpan(params: {
  workspaceId: string;
  traceId: string;
  spanId: string;
  parentId?: string;
  spanName: string;
  spanType?: string;
  startedAtMicros: number;
  durationMicros: number;
  statusCode: number;
  input: string;
  output: string;
  tagsString?: Record<string, string>;
  tagsBool?: Record<string, boolean>;
  tagsLong?: Record<string, number>;
  systemTagsLong?: Record<string, number>;
}): UploadSpan {
  return {
    started_at_micros: params.startedAtMicros,
    span_id: params.spanId,
    parent_id: params.parentId ?? "",
    trace_id: params.traceId,
    duration_micros: Math.max(1000, params.durationMicros),
    workspace_id: params.workspaceId,
    span_name: params.spanName,
    span_type: params.spanType ?? "custom",
    status_code: params.statusCode,
    input: params.input,
    output: params.output,
    object_storage: "",
    system_tags_string: {
      runtime: JSON.stringify({ language: "typescript", sdk: "openclaw/cozeloop-hook" }),
    },
    system_tags_long: params.systemTagsLong,
    tags_string: params.tagsString,
    tags_bool: params.tagsBool,
    tags_long: params.tagsLong,
  };
}

export default function register(api: OpenClawPluginApi): void {
  const cfg = resolveConfig(api);
  if (!cfg.enabled) {
    api.logger.info?.("cozeloop-hook: disabled");
    return;
  }
  if (!cfg.apiToken || !cfg.workspaceId) {
    api.logger.warn(
      "cozeloop-hook: missing apiToken/workspaceId (set plugin config or COZELOOP_API_TOKEN + COZELOOP_WORKSPACE_ID)",
    );
    return;
  }

  const client = createClient(cfg);
  const pendingByRun = new Map<string, PendingRun>();
  const pendingBySession = new Map<string, string>();

  const clearFinalizeTimer = (pending: PendingRun): void => {
    if (pending.finalizeTimer) {
      clearTimeout(pending.finalizeTimer);
      pending.finalizeTimer = undefined;
    }
  };

  const cleanupStaleRuns = (nowMs: number): void => {
    for (const [key, pending] of pendingByRun.entries()) {
      if (nowMs - pending.startedAtMs > RUN_STALE_MS) {
        clearFinalizeTimer(pending);
        pendingByRun.delete(key);
        if (pendingBySession.get(pending.sessionId) === key) {
          pendingBySession.delete(pending.sessionId);
        }
      }
    }
  };

  const reportFallbackAgentEndOnly = async (params: {
    event: PluginHookAgentEndEvent;
    ctx: PluginHookAgentContext;
    nowMs: number;
  }): Promise<void> => {
    const sessionId = params.ctx.sessionId ?? "unknown-session";
    const fallbackTraceId = createHexId(16);
    const fallbackRunId = resolveRunIdFromAgentEnd(params.event) ?? "unknown-run";
    const fallbackAgentName = resolveAgentName(api, params.ctx.agentId);
    const fallbackUsage = resolveUsage({ endEvent: params.event });
    const fallbackEndSpanId = createHexId(8);
    const fallbackStartedAtMicros =
      (params.nowMs - Math.max(1, params.event.durationMs ?? 1)) * 1000;
    const fallbackDurationMicros = Math.max(1000, (params.event.durationMs ?? 1) * 1000);
    const fallbackLatencyTags = buildLatencyTags({
      startedAtMs: Math.floor(fallbackStartedAtMicros / 1000),
      durationMs: params.event.durationMs,
    });
    const endOnlySpan = baseSpan({
      workspaceId: cfg.workspaceId,
      traceId: fallbackTraceId,
      spanId: fallbackEndSpanId,
      spanName: buildSpanName(cfg, fallbackAgentName, "agent_end"),
      spanType: cfg.agentSpanType,
      startedAtMicros: fallbackStartedAtMicros,
      durationMicros: fallbackDurationMicros,
      statusCode: params.event.success ? 0 : -1,
      input: stringifySafe(
        {
          sessionId,
          runId: fallbackRunId,
          context: {
            agentId: params.ctx.agentId,
            agentName: resolveAgentName(api, params.ctx.agentId),
            sessionKey: params.ctx.sessionKey,
            messageProvider: params.ctx.messageProvider,
          },
        },
        cfg.maxSerializedChars,
      ),
      output: stringifySafe(
        {
          success: params.event.success,
          error: params.event.error,
          durationMs: params.event.durationMs,
          messages: params.event.messages,
        },
        cfg.maxSerializedChars,
      ),
      tagsString: {
        hook: "agent_end",
        run_id: fallbackRunId,
        session_id: sessionId,
        agent_id: params.ctx.agentId ?? "",
        agent_name: resolveAgentName(api, params.ctx.agentId),
        message_provider: params.ctx.messageProvider ?? "",
      },
      tagsBool: {
        success: params.event.success,
      },
      tagsLong: {
        ...buildTokenTags(fallbackUsage),
        ...fallbackLatencyTags,
      },
      systemTagsLong: {
        ...buildTokenTags(fallbackUsage),
        ...fallbackLatencyTags,
      },
    });
    const fallbackDetailSpans = buildMessageDetailSpans({
      cfg,
      workspaceId: cfg.workspaceId,
      traceId: fallbackTraceId,
      parentId: fallbackEndSpanId,
      agentName: fallbackAgentName,
      runId: fallbackRunId,
      sessionId,
      startedAtMicros: fallbackStartedAtMicros,
      durationMicros: fallbackDurationMicros,
      messages: params.event.messages,
    });
    try {
      await client.ingest([endOnlySpan, ...fallbackDetailSpans]);
    } catch (err) {
      api.logger.warn(`cozeloop-hook: report failed: ${String(err)}`);
    }
  };

  const finalizePendingRun = async (key: string, pending: PendingRun): Promise<void> => {
    if (pending.finalizing || !pending.endEvent) {
      return;
    }
    pending.finalizing = true;
    clearFinalizeTimer(pending);

    const event = pending.endEvent;
    const endCtx = pending.endContext ?? pending.hookContext;
    const endAtMs = pending.endAtMs ?? Date.now();
    const sessionId = pending.sessionId;
    const traceId = pending.traceId;
    const llmSpanId = pending.llmSpanId;
    const runId = pending.runId;
    const startedAtMs = pending.startedAtMs;
    const agentId = pending.hookContext.agentId ?? endCtx.agentId;
    const messageProvider = pending.hookContext.messageProvider ?? endCtx.messageProvider;
    const agentName = resolveAgentName(api, agentId);

    const llmInputText = stringifySafe(
      {
        systemPrompt: pending.inputEvent.systemPrompt,
        prompt: pending.inputEvent.prompt,
        historyMessages: pending.inputEvent.historyMessages,
        imagesCount: pending.inputEvent.imagesCount,
      },
      cfg.maxSerializedChars,
    );
    const usageLong = resolveUsage({ outputEvent: pending.outputEvent, endEvent: event });
    const assistantTextsFromOutput = pending.outputEvent?.assistantTexts ?? [];
    const assistantTextsFromLastAssistant = extractAssistantTextsFromLastAssistant(
      pending.outputEvent?.lastAssistant,
    );
    const assistantTextsFallback = extractAssistantTextsFromMessages(event.messages);
    const assistantTexts =
      assistantTextsFromOutput.length > 0
        ? assistantTextsFromOutput
        : assistantTextsFromLastAssistant.length > 0
          ? assistantTextsFromLastAssistant
          : assistantTextsFallback;
    const llmOutputText = stringifySafe(
      {
        runId: pending.inputEvent.runId,
        sessionId: pending.inputEvent.sessionId,
        provider: pending.inputEvent.provider,
        model: pending.inputEvent.model,
        assistantTexts,
        usage: pending.outputEvent?.usage ?? {
          input: usageLong.input_tokens,
          output: usageLong.output_tokens,
          total: usageLong.tokens,
          inputCachedTokens: usageLong.input_cached_tokens,
          cacheRead: usageLong.cache_read_tokens,
          cacheWrite: usageLong.cache_write_tokens,
        },
        endSuccess: event.success,
        endError: event.error,
      },
      cfg.maxSerializedChars,
    );
    const tokenTags = buildTokenTags(usageLong);
    const latencyTags = buildLatencyTags({
      startedAtMs,
      outputAtMs: pending.outputAtMs,
      durationMs: event.durationMs,
    });
    const llmMetricTags = {
      ...tokenTags,
      ...latencyTags,
    };

    const endInputText = stringifySafe(
      {
        sessionId,
        runId,
        context: {
          agentId,
          agentName,
          sessionKey: endCtx.sessionKey ?? pending.hookContext.sessionKey,
          messageProvider,
        },
      },
      cfg.maxSerializedChars,
    );
    const endOutputText = stringifySafe(
      {
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
        messages: event.messages,
      },
      cfg.maxSerializedChars,
    );

    const spans: UploadSpan[] = [];
    const llmDurationMicros = Math.max(1000, (event.durationMs ?? 1) * 1000);
    const agentEndStartedAtMicros = (endAtMs - Math.max(1, event.durationMs ?? 1)) * 1000;
    const agentEndSpanId = createHexId(8);
    spans.push(
      baseSpan({
        workspaceId: cfg.workspaceId,
        traceId,
        spanId: llmSpanId,
        spanName: buildSpanName(cfg, agentName, "llm_input"),
        spanType: cfg.llmSpanType,
        startedAtMicros: startedAtMs * 1000,
        durationMicros: llmDurationMicros,
        statusCode: event.success ? 0 : -1,
        input: llmInputText,
        output: llmOutputText,
        tagsString: {
          hook: "llm_input",
          run_id: runId,
          session_id: sessionId,
          provider: pending.inputEvent.provider,
          model: pending.inputEvent.model,
          model_provider: pending.inputEvent.provider,
          model_name: pending.inputEvent.model,
          agent_id: agentId ?? "",
          agent_name: agentName,
          message_provider: messageProvider ?? "",
        },
        tagsLong: {
          images_count: pending.inputEvent.imagesCount,
          ...llmMetricTags,
        },
        systemTagsLong: llmMetricTags,
      }),
    );

    spans.push(
      baseSpan({
        workspaceId: cfg.workspaceId,
        traceId,
        spanId: agentEndSpanId,
        parentId: llmSpanId,
        spanName: buildSpanName(cfg, agentName, "agent_end"),
        spanType: cfg.agentSpanType,
        startedAtMicros: agentEndStartedAtMicros,
        durationMicros: llmDurationMicros,
        statusCode: event.success ? 0 : -1,
        input: endInputText,
        output: endOutputText,
        tagsString: {
          hook: "agent_end",
          run_id: runId,
          session_id: sessionId,
          agent_id: agentId ?? "",
          agent_name: agentName,
          message_provider: messageProvider ?? "",
        },
        tagsBool: {
          success: event.success,
        },
        tagsLong: latencyTags,
        systemTagsLong: latencyTags,
      }),
    );
    spans.push(
      ...buildMessageDetailSpans({
        cfg,
        workspaceId: cfg.workspaceId,
        traceId,
        parentId: agentEndSpanId,
        agentName,
        runId,
        sessionId,
        startedAtMicros: agentEndStartedAtMicros,
        durationMicros: llmDurationMicros,
        messages: event.messages,
      }),
    );

    try {
      await client.ingest(spans);
      if (cfg.localLogPath) {
        await appendLocalLog(api.resolvePath(cfg.localLogPath), {
          ts: new Date().toISOString(),
          ok: true,
          traceId,
          runId,
          sessionId,
          spanCount: spans.length,
        });
      }
    } catch (err) {
      api.logger.warn(`cozeloop-hook: report failed: ${String(err)}`);
      if (cfg.localLogPath) {
        try {
          await appendLocalLog(api.resolvePath(cfg.localLogPath), {
            ts: new Date().toISOString(),
            ok: false,
            traceId,
            runId,
            sessionId,
            spanCount: spans.length,
            error: String(err),
          });
        } catch {
          // ignore local log failures
        }
      }
    } finally {
      pendingByRun.delete(key);
    }
  };

  api.on("llm_input", async (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => {
    const nowMs = Date.now();
    cleanupStaleRuns(nowMs);

    const traceId = createHexId(16);
    const llmSpanId = createHexId(8);
    const key = runKey(event.runId, event.sessionId);
    const existing = pendingByRun.get(key);
    if (existing) {
      clearFinalizeTimer(existing);
    }

    pendingByRun.set(key, {
      runId: event.runId,
      sessionId: event.sessionId,
      traceId,
      llmSpanId,
      startedAtMs: nowMs,
      inputEvent: event,
      hookContext: ctx,
    });
    pendingBySession.set(event.sessionId, key);
  });

  api.on("llm_output", async (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => {
    const nowMs = Date.now();
    cleanupStaleRuns(nowMs);
    const key = runKey(event.runId, event.sessionId);
    const pending = pendingByRun.get(key);
    if (!pending) {
      return;
    }
    pending.outputAtMs = nowMs;
    pending.outputEvent = event;
    pending.outputContext = ctx;
    if (pending.endEvent) {
      await finalizePendingRun(key, pending);
    }
  });

  api.on("agent_end", async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    const nowMs = Date.now();
    cleanupStaleRuns(nowMs);

    const sessionId = ctx.sessionId ?? "unknown-session";
    const eventRunId = resolveRunIdFromAgentEnd(event);
    const keyByRunId = eventRunId ? runKey(eventRunId, sessionId) : undefined;
    const keyBySession = pendingBySession.get(sessionId);
    const key = keyByRunId && pendingByRun.has(keyByRunId) ? keyByRunId : keyBySession;
    const pending = key ? pendingByRun.get(key) : undefined;
    if (keyBySession && keyBySession === key) {
      pendingBySession.delete(sessionId);
    }

    if (!pending) {
      await reportFallbackAgentEndOnly({ event, ctx, nowMs });
      return;
    }

    pending.endEvent = event;
    pending.endContext = ctx;
    pending.endAtMs = nowMs;
    const resolvedKey = key ?? runKey(pending.runId, pending.sessionId);

    if (pending.outputEvent || cfg.llmOutputWaitMs <= 0) {
      await finalizePendingRun(resolvedKey, pending);
      return;
    }

    clearFinalizeTimer(pending);
    pending.finalizeTimer = setTimeout(() => {
      void finalizePendingRun(resolvedKey, pending);
    }, cfg.llmOutputWaitMs);
  });

  api.logger.info?.("cozeloop-hook: enabled");
}
