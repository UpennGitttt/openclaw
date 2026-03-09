function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatFeishuToolError(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  const result: Record<string, unknown> = { error: message };

  const response = isRecord(err) && isRecord(err.response) ? err.response : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const status = readNumber(response?.status);

  if (status !== undefined) {
    result.status = status;
  }
  if (!data) {
    return result;
  }

  const code = data.code;
  if (typeof code === "number" || typeof code === "string") {
    result.code = code;
  }

  const msg = readString(data.msg);
  if (msg) {
    result.msg = msg;
  }

  const logId = readString(data.log_id);
  if (logId) {
    result.log_id = logId;
  }

  const troubleshooter = readString(data.troubleshooter);
  if (troubleshooter) {
    result.troubleshooter = troubleshooter;
  }

  if (Array.isArray(data.permission_violations)) {
    result.permission_violations = data.permission_violations;
  }

  const hint = readString(data.message);
  if (hint) {
    result.hint = hint;
  }

  return result;
}
