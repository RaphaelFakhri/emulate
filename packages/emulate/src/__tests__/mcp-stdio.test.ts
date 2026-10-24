import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
        state: () => ({ count: 7 }),
        setup({ app, state }) {
          console.log("setup stdout noise");
          app.get("/", (c) => {
            process.stdout.write("request stdout noise\\n");
            return c.json(state);
          });
        }
      })
    }
  }
};
`,
      );
      const child = spawn(process.execPath, [join(root, "dist/index.js"), "mcp"], {
        cwd: directory,
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
      const client = new Client({ name: "stdio-test", version: "1.0.0" });
      const protocolErrors: Error[] = [];
      client.onerror = (error) => {
        protocolErrors.push(error);
      };
      try {
        await client.connect(new StdioServerTransport(child.stdout, child.stdin), { timeout: 10000 });
        child.stdin.write("{broken json\n");
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("start");
        const failed = await client.callTool({ name: "start", arguments: { port: "invalid" } });
        expect(failed.isError).toBe(true);
        if (watch) {
          const brokenConfig = join(directory, "broken.mjs");
          await writeFile(brokenConfig, 'throw new Error("startup failed");');
          const failedWatch = await client.callTool({
            name: "start",
            arguments: { config: brokenConfig, watch: true },
          });
          expect(failedWatch.isError).toBe(true);
        }
        const result = await client.callTool({ name: "start", arguments: { config, watch } });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()).toEqual({ count: 7 });
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        if (signal) child.kill(signal);
        else child.stdin.end();
        expect(await exited, stderr).toEqual({ code: 0, signal: null });
        await expect(fetch(url, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
        expect(protocolErrors).toEqual([]);
        for (const text of ["config stdout noise", "direct stdout noise", "setup stdout noise", "request stdout noise"])
          expect(stderr).toContain(text);
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 10000);
        try {
          await exited;
          await client.close();
        } finally {
          clearTimeout(timer);
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    30000,
  );
});
