import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it.each([
  { watch: false, signal: undefined },
  { watch: false, signal: "SIGTERM" as const },
  { watch: true, signal: undefined },
  { watch: true, signal: "SIGTERM" as const },
])(
  "closes bound listeners during a stalled startup: watch=$watch, signal=$signal",
  async ({ watch, signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-mcp-stalled-"));
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const { port } = socket.address() as AddressInfo;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    await mkdir(join(directory, "node_modules"));
    await symlink(root, join(directory, "node_modules/emulate"), "junction");
    const config = join(directory, "config.mjs");
    await writeFile(
      config,
      `
import { defineEmulator } from "emulate";
export default { services: { stalled: {
  port: ${port},
  emulator: defineEmulator({ name: "stalled", state: () => ({}), setup({ app }) { app.get("/", c => c.text("ready")); } }),
  persistence: { load: async () => null, save: () => new Promise(() => {}) }
} } };
`,
    );
    const child = spawn(process.execPath, [join(root, "dist/index.js"), "mcp"], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const client = new Client({ name: "shutdown-test", version: "1.0.0" });
    try {
      await client.connect(new StdioServerTransport(child.stdout, child.stdin), { timeout: 5000 });
      const starting = client.callTool({ name: "start", arguments: { config, watch } }).catch(() => undefined);
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).status;
            } catch {
              return undefined;
            }
          },
          { timeout: 5000 },
        )
        .toBe(503);
      if (signal) child.kill(signal);
      else child.stdin.end();
      await expect.poll(() => child.exitCode, { timeout: watch ? 10000 : 3000, message: stderr }).toBe(0);
      await starting;
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      child.kill("SIGKILL");
      await exited;
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
