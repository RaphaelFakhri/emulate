import { createInterface } from "node:readline";
import type { Command, Option } from "commander";
import { createProgram } from "./program.js";

declare const PKG_VERSION: string;

type Run = { close(): Promise<void> };
type Tool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    additionalProperties: false;
    required?: string[];
  };
};
type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Binding = { option: Option; owner: number; type: "string" | "boolean" };
type CommandTool = { tool: Tool; path: string[]; bindings: Map<string, Binding> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function result(
  data: Record<string, unknown>,
  text: string,
): CallToolResult & { structuredContent: Record<string, unknown> } {
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
      let captured: ReturnType<typeof result> | undefined;
      const program = createProgram({
        nonInteractive: true,
        output: (data, text) => {
          captured = result(data, text);
        },
        started: (run) => {
          started = run;
          if (closing) throw new Error("MCP server is closing");
          if (active) throw new Error("An emulator run is already active. Call stop before starting again.");
          active = run;
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
      if (name === "start" && captured.structuredContent?.ready === false)
        throw new Error(String(captured.structuredContent.error ?? "Emulator startup failed"));
      active = started ?? active;
      return captured;
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (started) {
        try {
          await started.close();
          if (active === started) active = undefined;
        } catch (cleanup) {
          active ??= started;
          message += `; cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
        }
      }
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
  const stdout = process.stdout;
  const stdin = process.stdin;
  const write = stdout.write;
  let input: ReturnType<typeof createInterface> | undefined;
  let shutdown!: () => void;
  stdout.write = process.stderr.write.bind(process.stderr) as typeof stdout.write;
  try {
    await new Promise<void>((resolve, reject) => {
      shutdown = () => {
        if (closing) return;
        closing = true;
        void stop().then(resolve, reject);
      };
      function send(
        id: string | number | null,
        response: { result: unknown } | { error: { code: number; message: string } },
      ) {
        if (closing) return;
        try {
          write.call(stdout, `${JSON.stringify({ jsonrpc: "2.0", id, ...response })}\n`);
        } catch {
          shutdown();
        }
      }
      function error(id: string | number | null, code: number, message: string) {
        send(id, { error: { code, message } });
      }
      function handleLine(line: string) {
        if (closing) return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          error(null, -32700, "Parse error");
          return;
        }
        if (!isObject(message)) {
          error(null, -32600, "Invalid request");
          return;
        }
        const { id, method, params } = message;
        const validId = typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
        if (message.jsonrpc !== "2.0" || typeof method !== "string" || ("id" in message && !validId)) {
          error(validId ? id : null, -32600, "Invalid request");
          return;
        }
        if (!validId) return;
        if (params !== undefined && (!isObject(params) || (params._meta !== undefined && !isObject(params._meta)))) {
          error(id, -32602, "params must be an object with object metadata");
          return;
        }
        switch (method) {
          case "initialize": {
            if (
              !params ||
              typeof params.protocolVersion !== "string" ||
              !isObject(params.capabilities) ||
              !isObject(params.clientInfo) ||
              typeof params.clientInfo.name !== "string" ||
              typeof params.clientInfo.version !== "string"
            ) {
              error(id, -32602, "initialize requires protocolVersion, capabilities, and clientInfo");
              return;
            }
            const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
            send(id, {
              result: {
                protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
                capabilities: { tools: {} },
                serverInfo: { name: "emulate", version: typeof PKG_VERSION === "string" ? PKG_VERSION : "0.0.0" },
                instructions:
                  "Commands share the emulate CLI handlers. Start owns one run until stop or this MCP connection closes; it does not detach a process.",
              },
            });
            return;
          }
          case "ping":
            send(id, { result: {} });
            return;
          case "tools/list":
            if (params?.cursor !== undefined && typeof params.cursor !== "string") {
              error(id, -32602, "cursor must be a string");
              return;
            }
            send(id, { result: { tools: [...commands.map((entry) => entry.tool), stopTool] } });
            return;
          case "tools/call": {
            if (
              !params ||
              typeof params.name !== "string" ||
              (params.arguments !== undefined && !isObject(params.arguments))
            ) {
              error(id, -32602, "tools/call requires a name and optional object arguments");
              return;
            }
            const name = params.name;
            const args = params.arguments ?? {};
            pending = pending
              .then(() => call(name, args))
              .then(
                (result) => send(id, { result }),
                () => error(id, -32603, "Internal error"),
              );
            return;
          }
          default:
            error(id, -32601, `Method not found: ${method}`);
        }
      }
      input = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
      input.on("line", handleLine);
      input.once("close", shutdown);
      input.once("error", shutdown);
      stdin.once("close", shutdown);
      stdin.once("error", shutdown);
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      stdout.once("error", shutdown);
      if (stdin.readableEnded || stdin.destroyed) shutdown();
    });
  } finally {
    input?.removeAllListeners("line");
    input?.off("close", shutdown);
    input?.off("error", shutdown);
    input?.close();
    stdin.off("close", shutdown);
    stdin.off("error", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    stdout.off("error", shutdown);
    stdout.write = write;
    stdin.pause();
  }
}
