import { PassThrough } from "node:stream";
import { Option, type Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram, type CommandContext } from "../program.js";
import { startMcpServer } from "../mcp.js";
import { createJsonRpcStream } from "./mcp-protocol.js";

type McpResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type Tool = {
  name: string;
  description?: string;
  inputSchema: { properties: Record<string, unknown>; [key: string]: unknown };
};
vi.mock("../program.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../program.js")>();
  return { ...original, createProgram: vi.fn(original.createProgram) };
});

const original = await vi.importActual<typeof import("../program.js")>("../program.js");
const cleanups: Array<() => Promise<void>> = [];
const unsupportedCommands: Array<[string, (program: Command) => void, string]> = [
  [
    "executable command",
    (p) => p.command("external", "External", { executableFile: "external.js" }),
    "Unsupported MCP command form",
  ],
  [
    "parent action",
    (p) =>
      p
        .command("parent")
        .action(() => {})
        .command("child"),
    "Unsupported MCP command form",
  ],
  [
    "wrong default type",
    (p) => p.command("bad").addOption(new Option("--count <count>").default(true)),
    "Unsupported MCP default",
  ],
  ["reserved stop name", (p) => p.command("stop"), "Conflicting or unsupported MCP tool name"],
  ["invalid tool name", (p) => p.command("invalid.name"), "Conflicting or unsupported MCP tool name"],
  [
    "colliding names",
    (p) => {
      p.command("parent_child");
      p.command("parent").command("child");
    },
    "Conflicting or unsupported MCP tool name",
  ],
  ["variadic option", (p) => p.command("bad").option("--items <items...>"), "Unsupported MCP option"],
  ["optional value", (p) => p.command("bad").option("--value [value]"), "Unsupported MCP option"],
  ["positional argument", (p) => p.command("bad <path>"), "positional arguments"],
];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.mocked(createProgram).mockImplementation(original.createProgram);
  }
});

async function connect() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.resume();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
  const client = createJsonRpcStream(stdout, stdin);
  const done = startMcpServer();
  cleanups.push(async () => {
    stdin.end();
    await done;
    client.close();
    stdout.destroy();
  });
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "emulate-test", version: "1.0.0" },
  });
  client.notification("notifications/initialized");
  return { client };
}

async function call(client: ReturnType<typeof createJsonRpcStream>, name: string, args: Record<string, unknown> = {}) {
  return (await client.request("tools/call", { name, arguments: args })).result as McpResult;
}

function message(result: McpResult) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("MCP command adapter", () => {
  it("lists canonical commands and derives option types, names, and CLI defaults", async () => {
    const { client } = await connect();
    const { tools } = (await client.request("tools/list", {})).result as { tools: Tool[] };
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...original.createProgram().commands.map((command) => command.name()), "stop"].sort(),
    );
    const start = tools.find((tool) => tool.name === "start")!;
    expect(start.description).toBe(
      original
        .createProgram()
        .commands.find((command) => command.name() === "start")!
        .description(),
    );
    expect(start.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        port: { type: "string", default: process.env.EMULATE_PORT ?? process.env.PORT ?? "4000" },
        host: { type: "string", default: "127.0.0.1" },
        generatedSecretsFile: { type: "string" },
        baseUrl: { type: "string" },
        watch: { type: "boolean" },
      },
    });
    expect(tools.find((tool) => tool.name === "list")!.inputSchema.properties).toHaveProperty("config");
    for (const tool of tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty("json");
      expect(tool.inputSchema.properties).not.toHaveProperty("help");
      expect(tool.inputSchema.properties).not.toHaveProperty("version");
    }
  });

  it("clears a failed start when closing its run also fails", async () => {
    const failedClose = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const successfulClose = vi.fn(async () => undefined);
    let starts = 0;
    vi.mocked(createProgram).mockImplementation((context) => {
      const program = original.createProgram(context);
      program.commands
        .find((command) => command.name() === "start")!
        .action(async () => {
          starts++;
          const ready = starts > 1;
          context!.started!({ close: ready ? successfulClose : failedClose });
          context!.output!({ ready, watching: false, services: [], ...(ready ? {} : { error: "startup failed" }) }, "");
        });
      return program;
    });
    const { client } = await connect();
    const failed = await call(client, "start");
    expect(failed.isError).toBe(true);
    expect(message(failed)).toContain("cleanup failed");
    expect((await call(client, "start")).isError).not.toBe(true);
    expect(starts).toBe(2);
    expect((await call(client, "stop")).isError).not.toBe(true);
    expect(failedClose).toHaveBeenCalledOnce();
    expect(successfulClose).toHaveBeenCalledOnce();
  });

  it("cancels starts queued before stop without cancelling a later start", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {});
    const start = vi.fn();
    vi.mocked(createProgram).mockImplementation((context) => {
      const program = original.createProgram(context);
      program.commands
        .find((command) => command.name() === "list")!
        .action(async () => {
          await waiting;
          context!.output!({ services: [] }, "");
        });
      program.commands
        .find((command) => command.name() === "start")!
        .action(() => {
          start();
          context!.started!({ close });
          context!.output!({ ready: true }, "");
        });
      return program;
    });
    const { client } = await connect();
    const listing = call(client, "list");
    const cancelled = call(client, "start");
    const stopping = call(client, "stop");
    const replacement = call(client, "start");
    try {
      expect((await stopping).isError).not.toBe(true);
    } finally {
      release();
    }
    await listing;
    expect(message(await cancelled)).toContain("startup stopped");
    expect((await replacement).structuredContent).toEqual({ ready: true });
    expect(start).toHaveBeenCalledOnce();
    await call(client, "stop");
    expect(close).toHaveBeenCalledOnce();
  });

  it("discovers a new nested command and flags and invokes its actual Commander handler", async () => {
    vi.mocked(createProgram).mockImplementation((context?: CommandContext) => {
      const program = original.createProgram(context);
      program
        .command("inspect")
        .option("--region <region>", "Region", "local")
        .command("echo")
        .alias("say")
        .requiredOption("--message <message>", "Message")
        .option("--loud", "Uppercase the message", true)
        .option("--no-color", "Disable color")
        .addOption(new Option("--mode <mode>", "Mode").choices(["plain", "raw"]).default("plain"))
        .action((options, command) => {
          const opts = command.optsWithGlobals();
          const text = options.loud ? options.message.toUpperCase() : options.message;
          context!.output!({ text, region: opts.region, color: opts.color, mode: opts.mode }, text);
        });
      return program;
    });
    const { client } = await connect();
    const { tools } = (await client.request("tools/list", {})).result as { tools: Tool[] };
    const tool = tools.find((tool) => tool.name === "inspect_echo")!;
    expect(tool.inputSchema).toMatchObject({
      required: ["message"],
      properties: {
        region: { type: "string", default: "local" },
        message: { type: "string" },
        loud: { type: "boolean", default: true },
        color: { type: "boolean", default: true },
        mode: { type: "string", default: "plain", enum: ["plain", "raw"] },
      },
    });
    expect((await call(client, "inspect_echo")).isError).toBe(true);
    expect((await call(client, "inspect_echo", { message: "ok", mode: "invalid" })).isError).toBe(true);
    const result = await call(client, "inspect_echo", {
      message: "--help; $(echo bad)",
      loud: false,
      color: false,
      region: "remote",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      text: "--help; $(echo bad)",
      color: false,
      region: "remote",
      mode: "plain",
    });
    expect((await call(client, "inspect_echo", { message: "hello" })).structuredContent).toEqual({
      text: "HELLO",
      color: true,
      region: "local",
      mode: "plain",
    });
  });

  it.each(unsupportedCommands)("rejects %s during automatic tool discovery", async (_name, add, error) => {
    vi.mocked(createProgram).mockImplementation((context) => {
      const program = original.createProgram(context);
      add(program);
      return program;
    });
    await expect(startMcpServer()).rejects.toThrow(error);
  });
});
