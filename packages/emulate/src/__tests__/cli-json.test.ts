import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

it("keeps executable config diagnostics out of CLI JSON results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emulate-json-"));
  try {
    const config = join(directory, "config.mjs");
    await writeFile(
      config,
      'console.log("config log"); process.stdout.write("config write\\n"); export default { services: { mail: { emulator: "resend" } } };',
    );
    const { stdout, stderr } = await execute(process.execPath, [cli, "list", "--config", config, "--json"], {
      cwd: directory,
    });
    expect(JSON.parse(stdout).configuredInstances).toEqual([{ name: "mail", source: "resend" }]);
    expect(stderr).toContain("config log");
    expect(stderr).toContain("config write");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("redacts advertised URL credentials in real CLI JSON readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emulate-json-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  const advertisedUrl = `http://cli-user:cli-password@localhost:${port}/?access_token=cli-token&apiKey=cli-api-key&public=kept`;
  const child = spawn(process.execPath, [cli, "start", "--service", "resend", "--port", String(port), "--json"], {
    cwd: directory,
    env: { ...process.env, EMULATE_BASE_URL: advertisedUrl, PORTLESS_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await Promise.race([
      once(lines, "line"),
      exited.then(([code, signal]) => {
        throw new Error(`CLI exited before readiness (${signal ?? code}): ${stderr}`);
      }),
    ]);
    const result = JSON.parse(line);
    expect(result.ready).toBe(true);
    const url = new URL(result.services[0].url);
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(url.searchParams.get("access_token")).toBe("[redacted]");
    expect(url.searchParams.get("apiKey")).toBe("[redacted]");
    expect(url.searchParams.get("public")).toBe("kept");
    for (const secret of ["cli-user", "cli-password", "cli-token", "cli-api-key"]) expect(line).not.toContain(secret);
    expect((await fetch(`http://127.0.0.1:${port}/emails`, { signal: AbortSignal.timeout(3000) })).status).toBe(200);
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      lines.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 15000);

it("keeps built CLI errors on the requested stream and exits cleanly for help and version", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: "utf8" });
  const json = run(["start", "--port", "bad", "--json"]);
  expect(json.status).toBe(1);
  expect(json.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1);
  expect(JSON.parse(json.stdout)).toEqual({ error: "Invalid port: bad" });
  expect(json.stderr).toBe("");

  const text = run(["start", "--port", "bad"]);
  expect(text.status).toBe(1);
  expect(text.stdout).toBe("");
  expect(text.stderr).toContain("Invalid port: bad");

  for (const args of [["--help"], ["--version"]]) expect(run(args).status).toBe(0);
});
