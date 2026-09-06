import { isDeepStrictEqual } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolCallEvent, type ToolResultEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import { secureVaultToolResult, EchoInkVaultToolEgressPolicy } from "./vault-tool-result-safety";

export const PI_OBSIDIAN_TOOL_IDS = ["obsidian_context", "obsidian_cli"] as const;
export type PiObsidianToolId = typeof PI_OBSIDIAN_TOOL_IDS[number];
export const OBSIDIAN_CLI_COMMANDS = ["version", "files", "search", "read", "daily:path", "templates"] as const;
export interface ObsidianCliRequest {
  command: typeof OBSIDIAN_CLI_COMMANDS[number];
  path?: string;
  folder?: string;
  query?: string;
  ext?: "md" | "base" | "canvas";
  limit?: number;
}

export interface ObsidianNativePort {
  context(): Promise<unknown>;
  cli(request: ObsidianCliRequest): Promise<unknown>;
}

interface NativeCall {
  toolName: PiObsidianToolId;
  input: Record<string, unknown>;
  state: "authorized" | "consumed" | "result_ready";
  result?: unknown;
  isError?: boolean;
}

function argumentsFor(tool: string, input: unknown): Record<string, unknown> {
  if (!PI_OBSIDIAN_TOOL_IDS.some((name) => name === tool) || !input || typeof input !== "object" || Array.isArray(input)
  ) throw new Error("obsidian_invalid_request");
  const args = input as Record<string, unknown>;
  if (tool === "obsidian_context") {
    if (Object.keys(args).length !== 0) throw new Error("obsidian_invalid_request");
    return {};
  }
  return { ...normalizeObsidianCliRequest(args) };
}

export function normalizeObsidianCliRequest(args: Record<string, unknown>): ObsidianCliRequest {
  const fields: Record<string, readonly string[]> = {
    version: [], files: ["folder", "ext"], search: ["query", "path", "limit"],
    read: ["path"], "daily:path": [], templates: []
  };
  const command = typeof args.command === "string" ? args.command : "";
  if (!OBSIDIAN_CLI_COMMANDS.some((name) => name === command)
    || Object.keys(args).some((key) => key !== "command" && !fields[command]?.includes(key))) {
    throw new Error("obsidian_cli_command_not_allowed");
  }
  for (const key of ["query", "path", "folder"]) {
    const value = args[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 1_000 || /[\0\r\n]/u.test(value))) {
      throw new Error("obsidian_invalid_request");
    }
  }
  if ((command === "read" && !args.path) || (command === "search" && !args.query)
    || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20))
    || (args.ext !== undefined && !["md", "base", "canvas"].includes(String(args.ext)))) {
    throw new Error("obsidian_invalid_request");
  }
  return args as unknown as ObsidianCliRequest;
}

/** Joins the existing tool_call permission gate and result redaction boundary. */
export class PiObsidianToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_OBSIDIAN_TOOL_IDS[0];
  readonly toolNames = PI_OBSIDIAN_TOOL_IDS;
  private readonly calls = new Map<string, NativeCall>();
  private readonly seen = new Set<string>();

  async handleToolCall(event: ToolCallEvent) {
    if (this.seen.has(event.toolCallId)) return { block: true as const, reason: "authorization_failed" };
    this.seen.add(event.toolCallId);
    try {
      const input = argumentsFor(event.toolName, event.input);
      this.calls.set(event.toolCallId, { toolName: event.toolName as PiObsidianToolId, input, state: "authorized" });
    } catch { return { block: true as const, reason: "tool_policy_blocked" }; }
  }

  consume(id: string, tool: PiObsidianToolId, input: unknown) {
    const call = this.calls.get(id);
    if (!call || call.state !== "authorized" || call.toolName !== tool || !isDeepStrictEqual(call.input, argumentsFor(tool, input))) {
      throw new Error("obsidian_authorization_failed");
    }
    call.state = "consumed";
    return call.input;
  }

  complete(id: string, result: unknown, isError = false): void {
    const call = this.calls.get(id);
    if (!call || call.state !== "consumed") throw new Error("obsidian_authorization_failed");
    call.result = result;
    call.isError = isError;
    call.state = "result_ready";
  }

  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId);
    this.calls.delete(event.toolCallId);
    const valid = call?.toolName === event.toolName && call?.state === "result_ready";
    const result = await secureVaultToolResult({
      toolId: event.toolName,
      effectType: "read",
      egressPolicy: "echoink-configured-provider-v1",
      value: valid ? call.result : { error: "obsidian_authorization_failed" },
      sizeLimitBytes: 32_000,
      egress: new EchoInkVaultToolEgressPolicy()
    });
    return {
      content: [{ type: "text" as const, text: result.text }],
      details: { source: "echoink-obsidian", toolCallId: event.toolCallId, truncated: result.truncated },
      isError: !valid || call?.isError === true || result.truncated
    };
  }
}

export function createPiObsidianToolDefinitions(port: ObsidianNativePort, security: PiObsidianToolSecurity): ToolDefinition[] {
  return [defineTool({
    name: "obsidian_context",
    label: "读取原生日记设置",
    description: "用户明确要保存日记时，读取当前 Obsidian 原生日记目录、日期格式、模板、当前时间、精确目标路径和已存在状态。返回与原生模板一致的已渲染正文；无需搜索 Vault 或询问路径。开场聊天不调用。只读，不创建文件。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (id, args) => {
      security.consume(id, "obsidian_context", args);
      try { security.complete(id, await port.context()); }
      catch (error) { security.complete(id, { error: error instanceof Error ? error.message : "obsidian_context_unavailable" }, true); }
      return { content: [{ type: "text" as const, text: "obsidian_result_pending_safety" }], details: {} };
    }
  }), defineTool({
    name: "obsidian_cli",
    label: "Obsidian 原生命令",
    description: "调用当前 Obsidian 应用自身 CLI 引擎的只读命令，固定当前 Vault。支持 version/files/search/read/daily:path/templates；不执行终端 shell 或 PATH 命令。不可用时返回原因并改用已有 Vault 工具。更新文件前仍必须 note_read 取得 expectedVersion，CLI read 不能替代版本读取。写入只使用现有 note_create/note_update 工具。",
    parameters: Type.Object({
      command: Type.Union(OBSIDIAN_CLI_COMMANDS.map((name) => Type.Literal(name))),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      folder: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      ext: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("base"), Type.Literal("canvas")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
    }, { additionalProperties: false }),
    execute: async (id, args) => {
      const request = security.consume(id, "obsidian_cli", args);
      try { security.complete(id, await port.cli(normalizeObsidianCliRequest(request))); }
      catch (error) { security.complete(id, { error: error instanceof Error ? error.message : "obsidian_cli_failed" }, true); }
      return { content: [{ type: "text" as const, text: "obsidian_result_pending_safety" }], details: {} };
    }
  })];
}
