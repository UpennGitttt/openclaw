import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const MAX_RETRIES = 5;
const DEFAULT_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RETRYABLE_CLIENT_STATUS_CODES = new Set([408, 409, 425, 429]);

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

type DeliveryMirrorPayload = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
};

export interface QueuedDelivery {
  id: string;
  enqueuedAt: number;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
  retryCount: number;
  lastError?: string;
}

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}

/** Ensure the queue directory (and failed/ subdirectory) exist. */
export async function ensureQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
};

export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureQueueDir(stateDir);
  const id = crypto.randomUUID();
  const entry: QueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: params.payloads,
    threadId: params.threadId,
    replyToId: params.replyToId,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    silent: params.silent,
    mirror: params.mirror,
    retryCount: 0,
  };
  const filePath = path.join(queueDir, `${id}.json`);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(entry, null, 2);
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
  return id;
}

/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code !== "ENOENT") {
      throw err;
    }
    // Already removed — no-op.
  }
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const entry: QueuedDelivery = JSON.parse(raw);
  entry.retryCount += 1;
  entry.lastError = error;
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const queueDir = resolveQueueDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const entries: QueuedDelivery[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      entries.push(JSON.parse(raw));
    } catch {
      // Skip malformed or inaccessible entries.
    }
  }
  return entries;
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  const src = path.join(queueDir, `${id}.json`);
  const dest = path.join(failedDir, `${id}.json`);
  await fs.promises.rename(src, dest);
}

/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryParams & {
      skipQueue?: boolean;
    },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export async function cleanupFailedDeliveries(opts: {
  stateDir?: string;
  retentionMs?: number;
  nowMs?: number;
  log?: RecoveryLogger;
}): Promise<{ scanned: number; removed: number; kept: number }> {
  const retentionMs =
    typeof opts.retentionMs === "number" && Number.isFinite(opts.retentionMs)
      ? Math.max(0, Math.floor(opts.retentionMs))
      : DEFAULT_FAILED_RETENTION_MS;
  // retentionMs === 0 means cleanup is disabled (not "delete everything").
  // Use a small positive value (e.g. 1) to express "immediate expiry".
  if (retentionMs <= 0) {
    return { scanned: 0, removed: 0, kept: 0 };
  }
  const failedDir = resolveFailedDir(opts.stateDir);
  const now =
    typeof opts.nowMs === "number" && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  let files: string[];
  try {
    files = await fs.promises.readdir(failedDir);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return { scanned: 0, removed: 0, kept: 0 };
    }
    throw err;
  }

  let scanned = 0;
  let removed = 0;
  let kept = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(failedDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      scanned += 1;
      const ageMs = now - stat.mtimeMs;
      if (ageMs > retentionMs) {
        await fs.promises.unlink(filePath);
        removed += 1;
      } else {
        kept += 1;
      }
    } catch {
      // Best-effort cleanup: keep malformed/unreadable entries.
      kept += 1;
    }
  }
  if (removed > 0) {
    opts.log?.info(
      `Delivery failed cleanup removed ${removed}/${scanned} entries older than ${retentionMs}ms`,
    );
  }
  return { scanned, removed, kept };
}

function extractHttpStatusCodeFromUnknown(err: unknown): number | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const candidate = err as {
    status?: unknown;
    response?: {
      status?: unknown;
    };
    message?: unknown;
  };
  if (typeof candidate.status === "number" && Number.isInteger(candidate.status)) {
    return candidate.status;
  }
  if (
    typeof candidate.response?.status === "number" &&
    Number.isInteger(candidate.response.status)
  ) {
    return candidate.response.status;
  }
  if (typeof candidate.message === "string") {
    const fromMessage = extractHttpStatusCodeFromMessage(candidate.message);
    if (fromMessage !== null) {
      return fromMessage;
    }
  }
  return null;
}

function extractHttpStatusCodeFromMessage(message?: string): number | null {
  if (!message) {
    return null;
  }
  const m = message.match(/\bstatus code (\d{3})\b/i);
  if (!m?.[1]) {
    return null;
  }
  const code = Number.parseInt(m[1], 10);
  if (!Number.isInteger(code)) {
    return null;
  }
  return code;
}

function isNonRetryableHttpStatus(code: number): boolean {
  return code >= 400 && code < 500 && !RETRYABLE_CLIENT_STATUS_CODES.has(code);
}

/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Override for testing — resolves instead of using real setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next restart. Default: 60 000. */
  maxRecoveryMs?: number;
  /** Keep failed queue entries for this many milliseconds before cleanup. Default: 30 days. */
  failedRetentionMs?: number;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  await cleanupFailedDeliveries({
    stateDir: opts.stateDir,
    retentionMs: opts.failedRetentionMs,
    log: opts.log,
  });
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return { recovered: 0, failed: 0, skipped: 0 };
  }

  // Process oldest first.
  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const delayFn = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of pending) {
    const now = Date.now();
    if (now >= deadline) {
      const deferred = pending.length - recovered - failed - skipped;
      opts.log.warn(`Recovery time budget exceeded — ${deferred} entries deferred to next restart`);
      break;
    }
    if (entry.retryCount >= MAX_RETRIES) {
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — moving to failed/`,
      );
      try {
        await moveToFailed(entry.id, opts.stateDir);
      } catch (err) {
        opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
      }
      skipped += 1;
      continue;
    }
    const lastStatusCode = extractHttpStatusCodeFromMessage(entry.lastError);
    if (lastStatusCode !== null && isNonRetryableHttpStatus(lastStatusCode)) {
      opts.log.warn(
        `Delivery ${entry.id} has non-retryable HTTP ${lastStatusCode} (lastError) — moving to failed/`,
      );
      try {
        await moveToFailed(entry.id, opts.stateDir);
      } catch (err) {
        opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
      }
      skipped += 1;
      continue;
    }

    const backoff = computeBackoffMs(entry.retryCount + 1);
    if (backoff > 0) {
      if (now + backoff >= deadline) {
        const deferred = pending.length - recovered - failed - skipped;
        opts.log.warn(
          `Recovery time budget exceeded — ${deferred} entries deferred to next restart`,
        );
        break;
      }
      opts.log.info(`Waiting ${backoff}ms before retrying delivery ${entry.id}`);
      await delayFn(backoff);
    }

    try {
      await opts.deliver({
        cfg: opts.cfg,
        channel: entry.channel,
        to: entry.to,
        accountId: entry.accountId,
        payloads: entry.payloads,
        threadId: entry.threadId,
        replyToId: entry.replyToId,
        bestEffort: entry.bestEffort,
        gifPlayback: entry.gifPlayback,
        silent: entry.silent,
        mirror: entry.mirror,
        skipQueue: true, // Prevent re-enqueueing during recovery
      });
      await ackDelivery(entry.id, opts.stateDir);
      recovered += 1;
      opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
    } catch (err) {
      const statusCode = extractHttpStatusCodeFromUnknown(err);
      if (statusCode !== null && isNonRetryableHttpStatus(statusCode)) {
        opts.log.warn(
          `Delivery ${entry.id} failed with non-retryable HTTP ${statusCode} — moving to failed/`,
        );
        try {
          await moveToFailed(entry.id, opts.stateDir);
        } catch (moveErr) {
          opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(moveErr)}`);
        }
        skipped += 1;
        continue;
      }
      try {
        await failDelivery(
          entry.id,
          err instanceof Error ? err.message : String(err),
          opts.stateDir,
        );
      } catch {
        // Best-effort update.
      }
      failed += 1;
      opts.log.warn(
        `Retry failed for delivery ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${recovered} recovered, ${failed} failed (retryable), ${skipped} skipped (${skipped} max-retries or non-retryable)`,
  );
  return { recovered, failed, skipped };
}

export { MAX_RETRIES };
