import { Writable } from "node:stream";
import type { Command, Option } from "commander";
import { Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createProgram } from "./program.js";

declare const PKG_VERSION: string;

type Run = { close(): Promise<void> };
type Binding = { option: Option; owner: number; type: "string" | "boolean" };
type CommandTool = { tool: Tool; path: string[]; bindings: Map<string, Binding> };

function discover(program: Command): CommandTool[] {
  const tools: CommandTool[] = [];
  function visit(command: Command, parents: Command[], path: string[]) {
    if (command.registeredArguments.length)
      throw new Error(`MCP does not support positional arguments: ${path.join(" ")}`);
    const chain = [...parents, command];
    if (
      Reflect.get(command, "_executableHandler") ||
      (command.commands.length && Reflect.get(command, "_actionHandler"))
    )
      throw new Error(`Unsupported MCP command form: ${path.join(" ")}`);
    if (command.commands.length) {
      for (const child of command.commands) visit(child, chain, [...path, child.name()]);
      return;
    }
    const bindings = new Map<string, Binding>();
    const properties: Record<
      string,
      { type: "string" | "boolean"; description: string; default?: string | boolean; enum?: string[] }
    > = Object.create(null);
    const required: string[] = [];
    for (const [owner, parent] of chain.entries()) {
      for (const option of parent.options) {
        if (["--json", "--help", "--version"].includes(option.long ?? "")) continue;
        const name = option.attributeName();
        if (!option.long || option.optional || option.variadic || bindings.has(name))
          throw new Error(`Unsupported MCP option for ${path.join(" ")}: ${option.flags}`);
        const type = option.required ? "string" : "boolean";
        const defaultValue = parent.getOptionValue(name);
        if (defaultValue !== undefined && typeof defaultValue !== type)
          throw new Error(`Unsupported MCP default for ${path.join(" ")}: ${option.flags}`);
        bindings.set(name, { option, owner, type });
        properties[name] = { type, description: option.description };
        if (defaultValue !== undefined) properties[name].default = defaultValue;
        if (option.argChoices) properties[name].enum = option.argChoices;
        if (option.mandatory && defaultValue === undefined && !option.envVar) required.push(name);
      }
    }
    const name = path.join("_");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || name === "stop" || tools.some((entry) => entry.tool.name === name))
      throw new Error(`Conflicting or unsupported MCP tool name: ${name}`);
    tools.push({
      path,
      bindings,
      tool: {
        name,
        description: command.description(),
        inputSchema: {
          type: "object",
          properties,
          additionalProperties: false,
          ...(required.length ? { required } : {}),
        },
      },
    });
  }
  for (const command of program.commands) visit(command, [program], [command.name()]);
  return tools;
}

function result(data: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: data };
}

export async function startMcpServer(): Promise<void> {
  const commands = discover(createProgram());
  const stopTool: Tool = {
    name: "stop",
    description: "Stop the emulator run owned by this MCP connection. A later start can create a new run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
  let active: Run | undefined;
  let pending = Promise.resolve();
  let closing = false;
  async function stop() {
    await active?.close();
    active = undefined;
  }
  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let started: Run | undefined;
    try {
      if (closing) throw new Error("MCP server is closing");
      const entry = commands.find((entry) => entry.tool.name === name);
      if (!entry && name !== "stop") throw new Error(`Unknown tool: ${name}`);
      for (const [key, value] of Object.entries(args)) {
        const binding = entry?.bindings.get(key);
        if (!binding) throw new Error(`Unknown argument for ${name}: ${key}`);
        if (typeof value !== binding.type) throw new Error(`${key} must be a ${binding.type}`);
      }
      if (name === "stop") {
        await stop();
        return result({ stopped: true }, "Stopped the owned emulator run.");
      }
      if (name === "start" && active)
        throw new Error("An emulator run is already active. Call stop before starting again.");
      let captured: CallToolResult | undefined;
      const program = createProgram({
        nonInteractive: true,
        output: (data, text) => {
          captured = result(data, text);
        },
        started: (run) => {
          started = run;
          if (active) throw new Error("An emulator run is already active. Call stop before starting again.");
        },
      });
      const chain = [program];
      for (const part of entry!.path) chain.push(chain.at(-1)!.commands.find((command) => command.name() === part)!);
      const configure = (command: Command) => {
        command.exitOverride().configureOutput({
          writeOut: (text) => {
            process.stderr.write(text);
          },
          writeErr: (text) => {
            process.stderr.write(text);
          },
        });
        for (const child of command.commands) configure(child);
      };
      configure(program);
      const argv = [...entry!.path];
      for (const [key, value] of Object.entries(args)) {
        const { option, owner, type } = entry!.bindings.get(key)!;
        if (type === "string") argv.push(`${option.long}=${value}`);
        else if (value === !option.negate) argv.push(option.long!);
        else chain[owner].setOptionValueWithSource(key, value, "cli");
      }
      await program.parseAsync(argv, { from: "user" });
      if (name === "start" && !started) throw new Error("Command start returned no owned run");
      if (!captured) throw new Error(`Command ${name} returned no structured result`);
      active = started ?? active;
      return captured;
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (started) {
        try {
          await started.close();
        } catch (cleanup) {
          active ??= started;
          message += `; cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
        }
      }
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
  function createServer() {
    const server = new Server(
      { name: "emulate", version: typeof PKG_VERSION === "string" ? PKG_VERSION : "0.0.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "Commands share the emulate CLI handlers. Start owns one run until stop or this MCP connection closes; it does not detach a process.",
      },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [...commands.map((entry) => entry.tool), stopTool],
    }));
    server.setRequestHandler("tools/call", (request) => {
      const response = pending.then(() => call(request.params.name, request.params.arguments ?? {}));
      pending = response.then(
        () => undefined,
        () => undefined,
      );
      return response.then((value) => server.projectCallToolResult(value, undefined));
    });
    server.onerror = (error) => {
      console.error(error);
    };
    return server;
  }
  const stdout = process.stdout;
  const stdin = process.stdin;
  const write = stdout.write;
  const output = new Writable({
    write(chunk, encoding, callback) {
      write.call(stdout, chunk, encoding, callback);
    },
  });
  let shutdown!: () => void;
  stdout.write = process.stderr.write.bind(process.stderr) as typeof stdout.write;
  try {
    await new Promise<void>((resolve, reject) => {
      const transport = new StdioServerTransport(stdin, output);
      const handle = serveStdio(createServer, {
        transport,
        onerror: (error) => {
          console.error(error);
        },
      });
      shutdown = () => {
        if (closing) return;
        closing = true;
        void (async () => {
          try {
            await pending;
            await stop();
          } finally {
            await handle.close();
          }
        })().then(resolve, reject);
      };
      const onclose = transport.onclose;
      transport.onclose = () => {
        onclose?.();
        shutdown();
      };
      stdin.once("end", shutdown);
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      stdout.once("error", shutdown);
      output.once("error", shutdown);
    });
  } finally {
    stdin.off("end", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    stdout.off("error", shutdown);
    output.off("error", shutdown);
    stdout.write = write;
    stdin.pause();
    output.destroy();
  }
}
