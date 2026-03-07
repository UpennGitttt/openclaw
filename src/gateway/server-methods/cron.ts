import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { readCronRunLogEntries, resolveCronRunLogPath } from "../../cron/run-log.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const FEISHU_VERIFY_TIMEOUT_MS = 8_000;

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function resolveFeishuApiBase(domain?: string): string {
  return domain?.trim().toLowerCase() === "lark"
    ? "https://open.larksuite.com/open-apis"
    : "https://open.feishu.cn/open-apis";
}

function resolveFeishuAccountCredentials(
  cfg: OpenClawConfig,
  accountId: string,
): { appId: string; appSecret: string; domain?: string } | null {
  const feishu = (cfg.channels?.feishu as Record<string, unknown> | undefined) ?? {};
  const accounts =
    (feishu.accounts as Record<string, Record<string, unknown> | undefined> | undefined) ?? {};
  const scoped = accounts[accountId] ?? {};
  const appId = String((scoped.appId ?? feishu.appId ?? "") as string).trim();
  const appSecret = String((scoped.appSecret ?? feishu.appSecret ?? "") as string).trim();
  const domain = String((scoped.domain ?? feishu.domain ?? "") as string).trim() || undefined;
  if (!appId || !appSecret) {
    return null;
  }
  return { appId, appSecret, domain };
}

async function fetchFeishuJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = (await response.json()) as Record<string, unknown>;
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyFeishuUserIdReachable(params: {
  appId: string;
  appSecret: string;
  domain?: string;
  userId: string;
  userIdType: "open_id" | "union_id";
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const apiBase = resolveFeishuApiBase(params.domain);
  const tokenRes = await fetchFeishuJson(
    `${apiBase}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: params.appId, app_secret: params.appSecret }),
    },
    FEISHU_VERIFY_TIMEOUT_MS,
  );
  const code = Number(tokenRes.code ?? -1);
  const tenantAccessToken =
    typeof tokenRes.tenant_access_token === "string" ? tokenRes.tenant_access_token.trim() : "";
  if (code !== 0 || !tenantAccessToken) {
    return { ok: false, reason: `token error: ${stringifyUnknown(tokenRes.msg ?? code)}` };
  }
  const userRes = await fetchFeishuJson(
    `${apiBase}/contact/v3/users/${encodeURIComponent(params.userId)}?user_id_type=${params.userIdType}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
      },
    },
    FEISHU_VERIFY_TIMEOUT_MS,
  );
  const userCode = Number(userRes.code ?? -1);
  if (userCode !== 0) {
    return { ok: false, reason: stringifyUnknown(userRes.msg ?? userCode) };
  }
  return { ok: true };
}

function resolveCronFeishuValidationInput(params: {
  cfg: OpenClawConfig;
  add?: CronJobCreate;
  patch?: CronJobPatch;
  existing?: CronJob;
}): { agentId: string; to: string } | null {
  const addDelivery = params.add?.delivery;
  const existingDelivery = params.existing?.delivery;
  const patchDelivery = params.patch?.delivery;
  const mode = patchDelivery?.mode ?? addDelivery?.mode ?? existingDelivery?.mode;
  if (mode && mode.toLowerCase() !== "announce") {
    return null;
  }
  const channelRaw = patchDelivery?.channel ?? addDelivery?.channel ?? existingDelivery?.channel;
  const to = (patchDelivery?.to ?? addDelivery?.to ?? existingDelivery?.to ?? "").trim();
  if (!to) {
    return null;
  }
  const channel = (channelRaw ?? "").trim().toLowerCase();
  const looksFeishu = /^(ou_|on_|oc_)/i.test(to);
  const isFeishu = channel === "feishu" || channel === "lark" || (!channel && looksFeishu);
  if (!isFeishu) {
    return null;
  }
  // open_id / union_id are app-scoped, these need strict account matching.
  if (!/^(ou_|on_)/i.test(to)) {
    return null;
  }
  const requestedAgentId =
    params.patch?.agentId !== undefined
      ? (params.patch.agentId ?? undefined)
      : (params.add?.agentId ?? params.existing?.agentId);
  const fallbackAgent = resolveDefaultAgentId(params.cfg);
  const agentId = normalizeAgentId(requestedAgentId ?? fallbackAgent);
  return { agentId, to };
}

async function validateCronFeishuRecipientMatch(params: {
  add?: CronJobCreate;
  patch?: CronJobPatch;
  existing?: CronJob;
}): Promise<string | null> {
  const cfg = loadConfig();
  const resolved = resolveCronFeishuValidationInput({ cfg, ...params });
  if (!resolved) {
    return null;
  }
  const bindings = buildChannelAccountBindings(cfg);
  const accounts = bindings.get("feishu")?.get(resolved.agentId) ?? [];
  if (accounts.length === 0) {
    return `delivery.to ${resolved.to} does not match feishu account for agent ${resolved.agentId}: no feishu binding`;
  }
  const userIdType = resolved.to.toLowerCase().startsWith("on_") ? "union_id" : "open_id";
  const reasons: string[] = [];
  for (const accountId of accounts) {
    const creds = resolveFeishuAccountCredentials(cfg, accountId);
    if (!creds) {
      reasons.push(`${accountId}: missing app credentials`);
      continue;
    }
    try {
      const probe = await verifyFeishuUserIdReachable({
        ...creds,
        userId: resolved.to,
        userIdType,
      });
      if (probe.ok) {
        return null;
      }
      reasons.push(`${accountId}: ${probe.reason}`);
    } catch (err) {
      reasons.push(`${accountId}: ${String(err)}`);
    }
  }
  return `delivery.to ${resolved.to} does not match feishu account for agent ${resolved.agentId}; checked ${accounts.join(", ")}; ${reasons.join(" | ")}`;
}

export const cronHandlers: GatewayRequestHandlers = {
  wake: ({ params, respond, context }) => {
    if (!validateWakeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      mode: "now" | "next-heartbeat";
      text: string;
    };
    const result = context.cron.wake({ mode: p.mode, text: p.text });
    respond(true, result, undefined);
  },
  "cron.list": async ({ params, respond, context }) => {
    if (!validateCronListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { includeDisabled?: boolean };
    const jobs = await context.cron.list({
      includeDisabled: p.includeDisabled,
    });
    respond(true, { jobs }, undefined);
  },
  "cron.status": async ({ params, respond, context }) => {
    if (!validateCronStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
        ),
      );
      return;
    }
    const status = await context.cron.status();
    respond(true, status, undefined);
  },
  "cron.add": async ({ params, respond, context }) => {
    const normalized = normalizeCronJobCreate(params) ?? params;
    if (!validateCronAddParams(normalized)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
        ),
      );
      return;
    }
    const jobCreate = normalized as unknown as CronJobCreate;
    const feishuValidationError = await validateCronFeishuRecipientMatch({ add: jobCreate });
    if (feishuValidationError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, feishuValidationError));
      return;
    }
    const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
    if (!timestampValidation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
      );
      return;
    }
    const job = await context.cron.add(jobCreate);
    respond(true, job, undefined);
  },
  "cron.update": async ({ params, respond, context }) => {
    const normalizedPatch = normalizeCronJobPatch((params as { patch?: unknown } | null)?.patch);
    const candidate =
      normalizedPatch && typeof params === "object" && params !== null
        ? { ...params, patch: normalizedPatch }
        : params;
    if (!validateCronUpdateParams(candidate)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
    };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"),
      );
      return;
    }
    const patch = p.patch as unknown as CronJobPatch;
    const existing = context.cron.getJob(jobId);
    if (!existing) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `cron job not found: ${jobId}`),
      );
      return;
    }
    const feishuValidationError = await validateCronFeishuRecipientMatch({
      patch,
      existing,
    });
    if (feishuValidationError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, feishuValidationError));
      return;
    }
    if (patch.schedule) {
      const timestampValidation = validateScheduleTimestamp(patch.schedule);
      if (!timestampValidation.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
        );
        return;
      }
    }
    const job = await context.cron.update(jobId, patch);
    respond(true, job, undefined);
  },
  "cron.remove": async ({ params, respond, context }) => {
    if (!validateCronRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.remove params: missing id"),
      );
      return;
    }
    const result = await context.cron.remove(jobId);
    respond(true, result, undefined);
  },
  "cron.run": async ({ params, respond, context }) => {
    if (!validateCronRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string; mode?: "due" | "force" };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.run params: missing id"),
      );
      return;
    }
    const result = await context.cron.run(jobId, p.mode ?? "force");
    respond(true, result, undefined);
  },
  "cron.runs": async ({ params, respond, context }) => {
    if (!validateCronRunsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string; limit?: number };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: missing id"),
      );
      return;
    }
    const logPath = resolveCronRunLogPath({
      storePath: context.cronStorePath,
      jobId,
    });
    const entries = await readCronRunLogEntries(logPath, {
      limit: p.limit,
      jobId,
    });
    respond(true, { entries }, undefined);
  },
};
