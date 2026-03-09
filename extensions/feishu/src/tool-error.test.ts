import { describe, expect, it } from "vitest";
import { formatFeishuToolError } from "./tool-error.js";

describe("formatFeishuToolError", () => {
  it("extracts message from a plain Error", () => {
    const result = formatFeishuToolError(new Error("something broke"));
    expect(result).toEqual({ error: "something broke" });
  });

  it("handles non-Error values (string)", () => {
    const result = formatFeishuToolError("raw string error");
    expect(result).toEqual({ error: "raw string error" });
  });

  it("handles null/undefined", () => {
    expect(formatFeishuToolError(null)).toEqual({ error: "null" });
    expect(formatFeishuToolError(undefined)).toEqual({ error: "undefined" });
  });

  it("extracts HTTP status from response", () => {
    const err = Object.assign(new Error("Request failed"), {
      response: { status: 403, data: {} },
    });
    const result = formatFeishuToolError(err);
    expect(result.status).toBe(403);
  });

  it("extracts Feishu API fields from response.data", () => {
    const err = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: {
          code: 99991672,
          msg: "Access denied",
          log_id: "LOG123",
          troubleshooter: "https://open.feishu.cn/search?log_id=LOG123",
          permission_violations: [{ scope: "docx:document:readonly" }],
          message: "Detailed hint message",
        },
      },
    });
    const result = formatFeishuToolError(err);
    expect(result).toMatchObject({
      error: "Request failed with status code 400",
      status: 400,
      code: 99991672,
      msg: "Access denied",
      log_id: "LOG123",
      troubleshooter: "https://open.feishu.cn/search?log_id=LOG123",
      permission_violations: [{ scope: "docx:document:readonly" }],
      hint: "Detailed hint message",
    });
  });

  it("handles response with missing data", () => {
    const err = Object.assign(new Error("timeout"), {
      response: { status: 504 },
    });
    const result = formatFeishuToolError(err);
    expect(result).toEqual({ error: "timeout", status: 504 });
  });

  it("handles response.data with string code", () => {
    const err = Object.assign(new Error("fail"), {
      response: { status: 400, data: { code: "INVALID_TOKEN" } },
    });
    expect(formatFeishuToolError(err).code).toBe("INVALID_TOKEN");
  });

  it("skips empty/whitespace-only string fields", () => {
    const err = Object.assign(new Error("fail"), {
      response: { status: 400, data: { msg: "  ", log_id: "", troubleshooter: "  " } },
    });
    const result = formatFeishuToolError(err);
    expect(result.msg).toBeUndefined();
    expect(result.log_id).toBeUndefined();
    expect(result.troubleshooter).toBeUndefined();
  });

  it("handles non-object response gracefully", () => {
    const err = Object.assign(new Error("fail"), {
      response: "not an object",
    });
    expect(formatFeishuToolError(err)).toEqual({ error: "fail" });
  });
});
