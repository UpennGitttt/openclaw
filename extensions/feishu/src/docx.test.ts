import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      media: {
        fetchRemoteMedia: fetchRemoteMediaMock,
      },
    },
  }),
}));

import { registerFeishuDocTools } from "./docx.js";

describe("feishu_doc image fetch hardening", () => {
  const convertMock = vi.hoisted(() => vi.fn());
  const blockListMock = vi.hoisted(() => vi.fn());
  const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
  const driveUploadAllMock = vi.hoisted(() => vi.fn());
  const blockPatchMock = vi.hoisted(() => vi.fn());
  const scopeListMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue({
      docx: {
        document: {
          convert: convertMock,
        },
        documentBlock: {
          list: blockListMock,
          patch: blockPatchMock,
        },
        documentBlockChildren: {
          create: blockChildrenCreateMock,
        },
      },
      drive: {
        media: {
          uploadAll: driveUploadAllMock,
        },
      },
      application: {
        scope: {
          list: scopeListMock,
        },
      },
    });

    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks: [{ block_type: 27 }],
        first_level_block_ids: [],
      },
    });

    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: [],
      },
    });

    blockChildrenCreateMock.mockResolvedValue({
      code: 0,
      data: {
        children: [{ block_type: 27, block_id: "img_block_1" }],
      },
    });

    driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
    blockPatchMock.mockResolvedValue({ code: 0 });
    scopeListMock.mockResolvedValue({ code: 0, data: { scopes: [] } });
  });

  it("skips image upload when markdown image URL is blocked", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchRemoteMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    const registerTool = vi.fn();
    registerFeishuDocTools({
      config: {
        channels: {
          feishu: {
            accounts: {
              default: {
                appId: "app_id",
                appSecret: "app_secret",
              },
            },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const factory = registerTool.mock.calls.find((call) => call[1]?.name === "feishu_doc")?.[0] as
      | ((ctx: OpenClawPluginToolContext) => { name: string; execute: (...args: any[]) => unknown })
      | undefined;
    const feishuDocTool = factory?.({
      agentAccountId: "default",
      config: {} as any,
      workspaceDir: "/tmp",
      agentDir: "/tmp",
      agentId: "main",
      sessionKey: "main",
      messageChannel: "feishu",
      sandboxed: false,
    });
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "write",
      doc_token: "doc_1",
      content: "![x](https://x.test/image.png)",
    });

    expect(fetchRemoteMediaMock).toHaveBeenCalled();
    expect(driveUploadAllMock).not.toHaveBeenCalled();
    expect(blockPatchMock).not.toHaveBeenCalled();
    expect(result.details.images_processed).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("surfaces Feishu API error details instead of only generic 400 text", async () => {
    const apiError = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: {
          code: 99991672,
          msg: "Access denied. Missing docx scope",
          log_id: "20260309012308D9E7EF963792D949EDE1",
          troubleshooter: "https://open.feishu.cn/search?log_id=test",
          permission_violations: [{ scope: "docx:document:readonly" }],
        },
      },
    });
    const rawContentMock = vi.fn().mockRejectedValue(apiError);
    const documentGetMock = vi.fn().mockResolvedValue({
      code: 0,
      data: { document: { title: "Doc" } },
    });
    const listMock = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: [] },
    });

    createFeishuClientMock.mockReturnValueOnce({
      docx: {
        document: {
          rawContent: rawContentMock,
          get: documentGetMock,
        },
        documentBlock: {
          list: listMock,
        },
      },
      application: {
        scope: {
          list: scopeListMock,
        },
      },
    });

    const registerTool = vi.fn();
    registerFeishuDocTools({
      config: {
        channels: {
          feishu: {
            accounts: {
              default: {
                appId: "app_id",
                appSecret: "app_secret",
              },
            },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const factory = registerTool.mock.calls.find((call) => call[1]?.name === "feishu_doc")?.[0] as
      | ((ctx: OpenClawPluginToolContext) => { name: string; execute: (...args: any[]) => unknown })
      | undefined;
    const feishuDocTool = factory?.({
      agentAccountId: "default",
      config: {} as any,
      workspaceDir: "/tmp",
      agentDir: "/tmp",
      agentId: "main",
      sessionKey: "main",
      messageChannel: "feishu",
      sandboxed: false,
    });
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "read",
      doc_token: "doc_1",
    });

    expect(result.details).toMatchObject({
      error: "Request failed with status code 400",
      status: 400,
      code: 99991672,
      msg: "Access denied. Missing docx scope",
      log_id: "20260309012308D9E7EF963792D949EDE1",
      troubleshooter: "https://open.feishu.cn/search?log_id=test",
      permission_violations: [{ scope: "docx:document:readonly" }],
    });
  });
});
