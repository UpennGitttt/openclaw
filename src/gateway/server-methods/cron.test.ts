import { beforeEach, describe, expect, it, vi } from "vitest";
import { cronHandlers } from "./cron.js";

const loadConfigMock = vi.fn();

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

describe("cronHandlers feishu recipient guard", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    vi.restoreAllMocks();
  });

  it("rejects cron.add when feishu open_id does not match agent-bound account", async () => {
    loadConfigMock.mockReturnValue({
      agents: { defaults: { id: "main" }, list: [{ id: "anthony" }] },
      bindings: [{ agentId: "anthony", match: { channel: "feishu", accountId: "anthony" } }],
      channels: {
        feishu: {
          accounts: {
            anthony: { appId: "app", appSecret: "secret" },
          },
        },
      },
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: "token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 99991663, msg: "user not found" }), { status: 200 }),
      );

    const cronAdd = vi.fn();
    const respond = vi.fn();
    await cronHandlers["cron.add"]({
      params: {
        name: "test",
        enabled: true,
        agentId: "anthony",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hello" },
        delivery: { mode: "announce", channel: "feishu", to: "ou_invalid" },
      },
      respond,
      // oxlint-disable-next-line typescript/no-explicit-any
      context: { cron: { add: cronAdd } } as any,
      client: null,
      req: { type: "req", id: "1", method: "cron.add", params: {} },
      isWebchatConnect: () => false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cronAdd).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("does not match feishu account"),
      }),
    );
  });

  it("rejects cron.update when patched delivery.to mismatches agent-bound feishu account", async () => {
    loadConfigMock.mockReturnValue({
      agents: { defaults: { id: "main" }, list: [{ id: "anthony" }] },
      bindings: [{ agentId: "anthony", match: { channel: "feishu", accountId: "anthony" } }],
      channels: {
        feishu: {
          accounts: {
            anthony: { appId: "app", appSecret: "secret" },
          },
        },
      },
    });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: "token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 99991663, msg: "user not found" }), { status: 200 }),
      );

    const cronUpdate = vi.fn();
    const cronGet = vi.fn().mockReturnValue({
      id: "job1",
      agentId: "anthony",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "announce", channel: "feishu", to: "ou_old" },
    });
    const respond = vi.fn();
    await cronHandlers["cron.update"]({
      params: {
        id: "job1",
        patch: {
          delivery: { mode: "announce", channel: "feishu", to: "ou_invalid" },
        },
      },
      respond,
      // oxlint-disable-next-line typescript/no-explicit-any
      context: { cron: { getJob: cronGet, update: cronUpdate } } as any,
      client: null,
      req: { type: "req", id: "2", method: "cron.update", params: {} },
      isWebchatConnect: () => false,
    });

    expect(cronUpdate).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("does not match feishu account"),
      }),
    );
  });
});
