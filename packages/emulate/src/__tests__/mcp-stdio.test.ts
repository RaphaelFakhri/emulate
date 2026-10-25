import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createJsonRpcStream, type JsonRpcMessage } from "./mcp-protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function toolResult(response: JsonRpcMessage) {
  return response.result as ToolResult;
}

function resultText(result: ToolResult) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function spawnMcpProcess(directory: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(root, "dist/index.js"), "mcp"], {
    cwd: directory,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, client: createJsonRpcStream(child.stdout, child.stdin), exited, stderr: () => stderr };
}

async function initialize(client: ReturnType<typeof createJsonRpcStream>, name: string) {
  const response = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name, version: "1.0.0" },
  });
  return response;
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe("built MCP stdio", () => {
  it.each([
    { watch: false, signal: undefined },
    { watch: true, signal: undefined },
    { watch: true, signal: "SIGTERM" as const },
    { watch: false, signal: "SIGINT" as const },
  ])(
    "keeps protocol stdout clean and closes workers: $watch, signal: $signal",
    async ({ watch, signal }) => {
      const directory = await mkdtemp(join(tmpdir(), "emulate-mcp-stdio-"));
      const port = await unusedPort();
      const url = `http://127.0.0.1:${port}/`;
      const advertisedUrl = `http://stdio-user:stdio-password@localhost:${port}/?access_token=stdio-token&access_token=stdio-token-two&client%5Fsecret=stdio-client-secret&apiKey=stdio-api-key&X-Amz-Signature=stdio-signature&public=kept`;
      const config = join(directory, "config.mjs");
      await mkdir(join(directory, "node_modules"));
      await symlink(root, join(directory, "node_modules/emulate"), "junction");
      await writeFile(
        config,
        `
import { defineEmulator } from "emulate";
console.log("config stdout noise");
process.stdout.write("direct stdout noise\\n");
export default {
  services: {
    counter: {
      port: ${port},
      emulator: defineEmulator({
        name: "counter",
        state: () => ({ count: 7, armed: false }),
        setup({ app, state, baseUrl, onDispose }) {
          console.log("setup stdout noise");
          onDispose(() => { if (state.armed) throw new Error("cleanup failed"); });
          app.get("/", (c) => {
            process.stdout.write("request stdout noise\\n");
            return c.json({ ...state, baseUrl });
          });
          app.post("/arm", (c) => { state.armed = true; return c.text("armed"); });
        }
      })
    }
  }
};
`,
      );
      const { child, client, exited, stderr } = spawnMcpProcess(directory, {
        ...process.env,
        EMULATE_BASE_URL: advertisedUrl,
        PORTLESS_URL: "",
      });
      try {
        const invalidInitialize = await client.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
        });
        expect(invalidInitialize.error?.code).toBe(-32602);
        const initialized = await initialize(client, "stdio-test");
        expect(initialized.error).toBeUndefined();
        expect(initialized.result).toMatchObject({ serverInfo: { name: "emulate" } });
        client.notification("notifications/initialized");
        expect((await client.request("ping")).result).toEqual({});

        client.writeRaw("{broken json\n");
        const parseError = await client.response(null);
        expect(parseError.error?.code).toBe(-32700);
        const malformed = await client.requestMessage({ jsonrpc: "2.0", id: 9001 });
        expect(malformed.error?.code).toBe(-32600);
        expect((await client.request("missing/method", {})).error?.code).toBe(-32601);
        expect((await client.request("tools/call", { name: 1, arguments: {} })).error?.code).toBe(-32602);

        const fragmented = { jsonrpc: "2.0", id: 9002, method: "tools/list", params: {} };
        const serialized = JSON.stringify(fragmented);
        const response = client.requestMessage(fragmented, serialized.slice(0, 12));
        expect(
          await Promise.race([
            response.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
          ]),
        ).toBe(false);
        client.writeRaw(`${serialized.slice(12)}\n`);
        const listed = await response;
        expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain("start");

        const invalidType = toolResult(
          await client.request("tools/call", { name: "start", arguments: { port: 4000 } }),
        );
        expect(invalidType.isError).toBe(true);
        for (const [args, expected] of [
          [{ extra: true }, "Unknown argument"],
          [{ watch: "true" }, "watch must be a boolean"],
        ] as const) {
          const invalidArguments = toolResult(await client.request("tools/call", { name: "start", arguments: args }));
          expect(invalidArguments.isError).toBe(true);
          expect(resultText(invalidArguments)).toContain(expected);
        }
        const unknownService = toolResult(
          await client.request("tools/call", {
            name: "start",
            arguments: { service: "constructor", port: String(port) },
          }),
        );
        expect(unknownService.isError).toBe(true);
        expect(resultText(unknownService)).toContain("Unknown service");
        const unknownTool = toolResult(await client.request("tools/call", { name: "absent", arguments: {} }));
        expect(unknownTool.isError).toBe(true);
        const failed = toolResult(
          await client.request("tools/call", { name: "start", arguments: { port: "invalid" } }),
        );
        expect(failed.isError).toBe(true);
        expect(resultText(failed)).toContain("Invalid port");
        if (watch) {
          const brokenConfig = join(directory, "broken.mjs");
          await writeFile(brokenConfig, 'throw new Error("startup failed");');
          const failedWatch = toolResult(
            await client.request("tools/call", { name: "start", arguments: { config: brokenConfig, watch: true } }),
          );
          expect(failedWatch.isError).toBe(true);
        }
        const start = client.request("tools/call", { name: "start", arguments: { config, watch } });
        const concurrentStart = client.request("tools/call", { name: "start", arguments: { config, watch } });
        let result = toolResult(await start);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const duplicate = toolResult(await concurrentStart);
        expect(duplicate.isError).toBe(true);
        expect(resultText(duplicate)).toContain("already active");

        if (!watch && !signal) {
          expect((await fetch(`${url}arm`, { method: "POST" })).status).toBe(200);
          const stopped = toolResult(await client.request("tools/call", { name: "stop", arguments: {} }));
          expect(stopped.isError).toBe(true);
          expect(resultText(stopped)).toContain("Failed to shut down project");
          await expect(fetch(url, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
          result = toolResult(await client.request("tools/call", { name: "start", arguments: { config, watch } }));
          expect(result.isError).not.toBe(true);
          expect((await fetch(url)).status).toBe(200);
          const stoppedAgain = toolResult(await client.request("tools/call", { name: "stop", arguments: {} }));
          expect(stoppedAgain.isError).not.toBe(true);
          await expect(fetch(url, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
          result = toolResult(await client.request("tools/call", { name: "start", arguments: { config, watch } }));
          expect(result.isError).not.toBe(true);
          expect((await fetch(url)).status).toBe(200);
        }
        const { services } = result.structuredContent as {
          services: Array<{ url: string; inspectorUrl: string }>;
        };
        for (const value of [services[0].url, services[0].inspectorUrl]) {
          const advertised = new URL(value);
          expect(advertised.username).toBe("");
          expect(advertised.password).toBe("");
          expect(advertised.searchParams.getAll("access_token")).toEqual(["[redacted]"]);
          for (const key of ["client_secret", "apiKey", "X-Amz-Signature"])
            expect(advertised.searchParams.get(key)).toBe("[redacted]");
        }
        expect(new URL(services[0].url).searchParams.get("public")).toBe("kept");
        for (const secret of [
          "stdio-user",
          "stdio-password",
          "stdio-token",
          "stdio-client-secret",
          "stdio-api-key",
          "stdio-signature",
        ])
          expect(JSON.stringify(result)).not.toContain(secret);
        expect(await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()).toEqual({
          count: 7,
          armed: false,
          baseUrl: advertisedUrl,
        });
        expect(((await client.request("tools/list", {})).result as { tools: unknown[] }).tools.length).toBeGreaterThan(
          0,
        );
        if (signal) child.kill(signal);
        else child.stdin.end();
        expect(await exited, stderr()).toEqual({ code: 0, signal: null });
        await expect(fetch(url, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
        for (const text of ["config stdout noise", "direct stdout noise", "setup stdout noise", "request stdout noise"])
          expect(stderr()).toContain(text);
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 10000);
        try {
          await exited;
          client.close();
        } finally {
          clearTimeout(timer);
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    30000,
  );
});
