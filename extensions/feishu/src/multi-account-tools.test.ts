import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      media: {
        fetchRemoteMedia: vi.fn(),
      },
    },
  }),
}));

import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuDocTools } from "./docx.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerFeishuPermTools } from "./perm.js";
import { registerFeishuWikiTools } from "./wiki.js";

function buildConfig() {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          anthony: {
            appId: "cli_anthony",
            appSecret: "secret_anthony",
            enabled: true,
            tools: { doc: true, drive: true, wiki: true, perm: true },
          },
          default: {
            appId: "cli_default",
            appSecret: "secret_default",
            enabled: true,
            tools: { doc: true, drive: true, wiki: true, perm: true },
          },
        },
      },
    },
  };
}

function makeClient() {
  return {
    docx: {
      document: {
        rawContent: vi.fn().mockResolvedValue({ code: 0, data: { content: "hello" } }),
        get: vi.fn().mockResolvedValue({ code: 0, data: { document: { title: "Doc" } } }),
        create: vi
          .fn()
          .mockResolvedValue({ code: 0, data: { document: { document_id: "doc", title: "Doc" } } }),
        convert: vi
          .fn()
          .mockResolvedValue({ code: 0, data: { blocks: [], first_level_block_ids: [] } }),
      },
      documentBlock: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        get: vi.fn().mockResolvedValue({ code: 0, data: { block: { parent_id: "doc" } } }),
        patch: vi.fn().mockResolvedValue({ code: 0 }),
      },
      documentBlockChildren: {
        create: vi.fn().mockResolvedValue({ code: 0, data: { children: [] } }),
        get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        batchDelete: vi.fn().mockResolvedValue({ code: 0 }),
      },
    },
    drive: {
      file: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { files: [] } }),
        createFolder: vi
          .fn()
          .mockResolvedValue({ code: 0, data: { token: "fld", url: "https://example.test/fld" } }),
        move: vi.fn().mockResolvedValue({ code: 0, data: { task_id: "task" } }),
        delete: vi.fn().mockResolvedValue({ code: 0, data: { task_id: "task" } }),
      },
      permissionMember: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        create: vi.fn().mockResolvedValue({ code: 0, data: { member: {} } }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
      media: {
        uploadAll: vi.fn().mockResolvedValue({ file_token: "file_token" }),
      },
    },
    wiki: {
      space: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        getNode: vi
          .fn()
          .mockResolvedValue({
            code: 0,
            data: { node: { obj_type: "docx", obj_token: "obj", title: "node" } },
          }),
      },
      spaceNode: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        create: vi
          .fn()
          .mockResolvedValue({
            code: 0,
            data: {
              node: { node_token: "node", obj_token: "obj", obj_type: "docx", title: "title" },
            },
          }),
        move: vi.fn().mockResolvedValue({ code: 0, data: { node: { node_token: "node" } } }),
        updateTitle: vi.fn().mockResolvedValue({ code: 0 }),
      },
    },
    bitable: {
      app: {
        get: vi.fn().mockResolvedValue({ code: 0, data: { app: { name: "base" } } }),
        create: vi.fn().mockResolvedValue({ code: 0, data: { app: { app_token: "app" } } }),
      },
      appTable: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        create: vi.fn().mockResolvedValue({ code: 0, data: { table_id: "tbl" } }),
      },
      appTableField: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        create: vi.fn().mockResolvedValue({ code: 0, data: { field: {} } }),
      },
      appTableRecord: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        search: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        create: vi.fn().mockResolvedValue({ code: 0, data: { record: {} } }),
        update: vi.fn().mockResolvedValue({ code: 0, data: { record: {} } }),
      },
    },
    application: {
      scope: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { scopes: [] } }),
      },
    },
  };
}

function fakeApi(registerTool: ReturnType<typeof vi.fn>): OpenClawPluginApi {
  return {
    id: "feishu",
    name: "feishu",
    source: "test",
    config: buildConfig() as any,
    pluginConfig: {},
    runtime: {} as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool,
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerHook() {},
    registerCommand() {},
    on() {},
    resolvePath: (input) => input,
  };
}

function fakeCtx(accountId: string): OpenClawPluginToolContext {
  return {
    config: buildConfig() as any,
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "feishu:default:dm",
    messageChannel: "feishu",
    agentAccountId: accountId,
    sandboxed: false,
  };
}

function getRegisteredFactory(registerTool: ReturnType<typeof vi.fn>, name: string) {
  const call = registerTool.mock.calls.find((entry) => {
    const opts = entry[1] as { name?: string; names?: string[] } | undefined;
    return opts?.name === name || opts?.names?.includes(name);
  });
  expect(call).toBeDefined();
  expect(typeof call?.[0]).toBe("function");
  return call?.[0] as (ctx: OpenClawPluginToolContext) => unknown;
}

function selectTool(factoryResult: unknown, name: string) {
  if (Array.isArray(factoryResult)) {
    return factoryResult.find((tool) => (tool as { name?: string }).name === name) as {
      execute: (toolCallId: string, params: unknown) => Promise<{ details: unknown }>;
    };
  }
  return factoryResult as {
    execute: (toolCallId: string, params: unknown) => Promise<{ details: unknown }>;
  };
}

describe("feishu multi-account tools", () => {
  beforeEach(() => {
    createFeishuClientMock.mockReset();
    createFeishuClientMock.mockImplementation((account) => ({
      ...makeClient(),
      __account: account,
    }));
  });

  it("binds feishu_doc to the current agent account", async () => {
    const registerTool = vi.fn();
    registerFeishuDocTools(fakeApi(registerTool));

    const factory = getRegisteredFactory(registerTool, "feishu_doc");
    const tool = selectTool(factory(fakeCtx("default")), "feishu_doc");
    await tool.execute("call-doc", { action: "read", doc_token: "doc_token" });

    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", appId: "cli_default" }),
    );
  });

  it("binds feishu_drive to the current agent account", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(fakeApi(registerTool));

    const factory = getRegisteredFactory(registerTool, "feishu_drive");
    const tool = selectTool(factory(fakeCtx("default")), "feishu_drive");
    await tool.execute("call-drive", { action: "list" });

    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", appId: "cli_default" }),
    );
  });

  it("binds feishu_perm to the current agent account", async () => {
    const registerTool = vi.fn();
    registerFeishuPermTools(fakeApi(registerTool));

    const factory = getRegisteredFactory(registerTool, "feishu_perm");
    const tool = selectTool(factory(fakeCtx("default")), "feishu_perm");
    await tool.execute("call-perm", { action: "list", token: "tok", type: "docx" });

    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", appId: "cli_default" }),
    );
  });

  it("binds feishu_wiki to the current agent account", async () => {
    const registerTool = vi.fn();
    registerFeishuWikiTools(fakeApi(registerTool));

    const factory = getRegisteredFactory(registerTool, "feishu_wiki");
    const tool = selectTool(factory(fakeCtx("default")), "feishu_wiki");
    await tool.execute("call-wiki", { action: "spaces" });

    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", appId: "cli_default" }),
    );
  });

  it("binds feishu_bitable tools to the current agent account", async () => {
    const registerTool = vi.fn();
    registerFeishuBitableTools(fakeApi(registerTool));

    const factory = getRegisteredFactory(registerTool, "feishu_bitable_get_meta");
    const tools = factory(fakeCtx("default"));
    const tool = selectTool(tools, "feishu_bitable_get_meta");
    await tool.execute("call-bitable", { url: "https://example.feishu.cn/base/app_token" });

    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", appId: "cli_default" }),
    );
  });
});
