import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { Option } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram, type CommandContext } from "../program.js";
import { startMcpServer } from "../mcp.js";

vi.mock("@modelcontextprotocol/server/stdio", async (importOriginal) => {
  const original = await importOriginal<typeof import("@modelcontextprotocol/server/stdio")>();
  return { ...original, StdioServerTransport: vi.fn() };
});
vi.mock("../program.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../program.js")>();
  return { ...original, createProgram: vi.fn(original.createProgram) };
});

const original = await vi.importActual<typeof import("../program.js")>("../program.js");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.mocked(createProgram).mockImplementation(original.createProgram);
  }
});

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  vi.mocked(StdioServerTransport).mockImplementation(function () {
    return serverTransport as unknown as StdioServerTransport;
  });
  const stdin = new PassThrough();
  stdin.resume();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  const done = startMcpServer();
  const client = new Client({ name: "emulate-test", version: "1.0.0" });
  cleanups.push(async () => {
    await client.close();
    await done;
    stdin.destroy();
  });
  await client.connect(clientTransport);
  return { client, stdin, done };
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function config() {
  const directory = await mkdtemp(join(tmpdir(), "emulate-mcp-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const port = await unusedPort();
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({ services: { resend: { emulator: "resend", port } } }));
  return { path, url: `http://127.0.0.1:${port}/inbox` };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function message(result: CallToolResult) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("MCP command adapter", () => {
  it("lists canonical commands and derives option types, names, and CLI defaults", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["init", "list", "start", "stop"]);
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

  it("returns the same structured result as the CLI using the real list handler", async () => {
    const fixture = await config();
    let cli: Record<string, unknown> | undefined;
    await original
      .createProgram({
        output: (data) => {
          cli = data;
        },
        nonInteractive: true,
      })
      .exitOverride()
      .parseAsync(["list", "--config", fixture.path, "--json"], { from: "user" });
    const { client } = await connect();
    const result = await call(client, "list", { config: fixture.path });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(cli);
    expect(message(result)).not.toBe("");
  });

  it("keeps serving after unknown keys, wrong types, CLI validation errors, and handler errors", async () => {
    const { client } = await connect();
    for (const [name, args, error] of [
      ["list", { unknown: true }, "Unknown argument"],
      ["list", { json: true }, "Unknown argument"],
      ["list", { help: true }, "Unknown argument"],
      ["list", { version: true }, "Unknown argument"],
      ["start", { port: 4000 }, "port must be a string"],
      ["start", { watch: "true" }, "watch must be a boolean"],
      ["start", { port: "0" }, "port"],
      ["start", { service: "not-a-service" }, "service"],
      ["list", { config: "/missing/emulate-mcp-config.json" }, "config"],
      ["absent", {}, "Unknown tool"],
      ["stop", { config: "anything" }, "Unknown argument"],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError).toBe(true);
      expect(message(result).toLowerCase()).toContain(error.toLowerCase());
      expect((await client.listTools()).tools.some((tool) => tool.name === "list")).toBe(true);
    }
    expect((await call(client, "list")).isError).not.toBe(true);
  });

  it("serves HTTP at readiness, rejects concurrent starts, and lets stop release the port for another start", async () => {
    const fixture = await config();
    const { client } = await connect();
    const results = await Promise.all([
      call(client, "start", { config: fixture.path }),
      call(client, "start", { config: fixture.path }),
    ]);
    expect(results[0].isError).not.toBe(true);
    expect(results[0].structuredContent).toBeDefined();
    expect((await fetch(fixture.url)).status).toBe(200);
    expect(results[1].isError).toBe(true);
    expect(message(results[1])).toContain("already active");
    expect((await call(client, "stop")).isError).not.toBe(true);
    await expect(fetch(fixture.url)).rejects.toThrow();
    expect((await call(client, "start", { config: fixture.path })).isError).not.toBe(true);
    expect((await fetch(fixture.url)).status).toBe(200);
    await call(client, "stop");
  });

  it("closes its listener on EOF and removes signal handlers", async () => {
    const fixture = await config();
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const { client, stdin, done } = await connect();
    expect((await call(client, "start", { config: fixture.path })).isError).not.toBe(true);
    expect((await fetch(fixture.url)).status).toBe(200);
    stdin.end();
    await done;
    await expect(fetch(fixture.url)).rejects.toThrow();
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("cleans up a start still waiting for readiness when stdin closes", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const close = vi.fn(async () => undefined);
    vi.mocked(createProgram).mockImplementation((context) => {
      const program = original.createProgram(context);
      program.commands
        .find((command) => command.name() === "start")!
        .action(async () => {
          entered();
          await ready;
          context!.started!({ close });
          context!.output!({ ready: true }, "Ready");
        });
      return program;
    });
    const { client, stdin, done } = await connect();
    const starting = call(client, "start");
    await entering;
    stdin.end();
    release();
    await Promise.allSettled([starting, done]);
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
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "inspect_echo")!;
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

  it.each(["--items <items...>", "--value [value]"])(
    "refuses unsupported option forms instead of omitting %s",
    async (flags) => {
      vi.mocked(createProgram).mockImplementation((context) => {
        const program = original.createProgram(context);
        program.command("unsupported").option(flags);
        return program;
      });
      await expect(startMcpServer()).rejects.toThrow("Unsupported MCP option");
    },
  );

  it("refuses positional arguments instead of advertising an unusable command", async () => {
    vi.mocked(createProgram).mockImplementation((context) => {
      const program = original.createProgram(context);
      program.command("unsupported <path>");
      return program;
    });
    await expect(startMcpServer()).rejects.toThrow("positional arguments");
  });
});
