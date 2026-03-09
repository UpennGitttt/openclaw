// Prevent duplicate processing when WebSocket reconnects or Feishu redelivers messages.
// Uses file-backed persistence so the dedup cache survives gateway restarts.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // cleanup every 5 minutes

/**
 * Resolve the dedup file path. Accepts an optional `stateDir` to align with
 * the system-wide data directory; falls back to `~/.openclaw/data/` when no
 * explicit directory is provided (e.g. during standalone tests).
 */
function resolveDedupFile(stateDir?: string): string {
  const base = stateDir ?? join(homedir(), ".openclaw", "data");
  return join(base, "feishu-dedup.jsonl");
}

let processedMessageIds = new Map<string, number>(); // messageId -> timestamp
let lastCleanupTime = Date.now();
let initialized = false;
let activeDedupFile: string | undefined;

/** Reset all module-level state. Intended for tests only. */
export function _resetForTesting(): void {
  processedMessageIds = new Map();
  lastCleanupTime = Date.now();
  initialized = false;
  activeDedupFile = undefined;
}

/** Ensure the data directory exists and load persisted entries. */
function ensureInitialized(stateDir?: string): void {
  if (initialized) return;
  initialized = true;

  activeDedupFile = resolveDedupFile(stateDir);
  try {
    mkdirSync(dirname(activeDedupFile), { recursive: true });
  } catch {
    // directory already exists
  }

  const now = Date.now();
  try {
    const raw = readFileSync(activeDedupFile, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const { id, ts } = JSON.parse(line) as { id: string; ts: number };
        if (now - ts < DEDUP_TTL_MS) {
          processedMessageIds.set(id, ts);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file doesn't exist yet — first run
  }

  // Rewrite file with only valid (non-expired) entries to compact it.
  flushToDisk();
}

/** Rewrite the dedup file with current in-memory state (compaction). */
function flushToDisk(): void {
  if (!activeDedupFile) return;
  try {
    const lines = Array.from(processedMessageIds.entries())
      .map(([id, ts]) => JSON.stringify({ id, ts }))
      .join("\n");
    writeFileSync(activeDedupFile, lines ? lines + "\n" : "", "utf-8");
  } catch {
    // non-fatal: dedup still works in-memory
  }
}

export function tryRecordMessage(messageId: string, stateDir?: string): boolean {
  ensureInitialized(stateDir);
  const now = Date.now();

  // Throttled cleanup: evict expired entries at most once per interval.
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) {
        processedMessageIds.delete(id);
      }
    }
    lastCleanupTime = now;
    flushToDisk(); // compact file during cleanup
  }

  if (processedMessageIds.has(messageId)) {
    return false;
  }

  // Evict oldest entries if cache is full.
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }

  processedMessageIds.set(messageId, now);

  // Append new entry to disk immediately.
  if (activeDedupFile) {
    try {
      appendFileSync(activeDedupFile, JSON.stringify({ id: messageId, ts: now }) + "\n", "utf-8");
    } catch {
      // non-fatal
    }
  }

  return true;
}
