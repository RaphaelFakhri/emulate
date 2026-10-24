import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";
import { initCommand } from "../commands/init.js";
import { listCommand } from "../commands/list.js";
import { scaffoldCommand } from "../commands/scaffold.js";

let directory: string;
let previousDirectory: string;
const runs: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  previousDirectory = process.cwd();
  directory = await realpath(await mkdtemp(join(tmpdir(), "emulate-commands-")));
  vi.stubEnv("EMULATE_BASE_URL", "");
  vi.stubEnv("PORTLESS_URL", "");
  process.chdir(directory);
});

afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.close()));
  process.chdir(previousDirectory);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe("shared command execution", () => {
  it("returns handler results without printing and refuses to overwrite an existing init config", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = initCommand({ service: "resend" });
    expect(result.data.path).toBe(join(directory, "emulate.config.yaml"));
    const before = await readFile(result.data.path, "utf8");
    expect(before).toContain("resend:");
    expect(before).not.toContain("github:");
    expect(() => initCommand({ service: "all" })).toThrow("Config file already exists");
    expect(await readFile(result.data.path, "utf8")).toBe(before);
    expect((await listCommand()).text).toContain("Available services:");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(["missing", "toString"])("rejects unknown init service %s without creating a config", async (service) => {
    await expect(createProgram().parseAsync(["init", "--service", service], { from: "user" })).rejects.toThrow(
      "Unknown service",
    );
    await expect(readFile(join(directory, "emulate.config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the CLI init text and prints a single JSON result when requested", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["init", "--service", "resend"], { from: "user" });
    expect(stdout.mock.calls).toEqual([["Created emulate.config.yaml\n\nRun 'npx emulate' to start the emulator."]]);
    stdout.mockClear();
    await createProgram().parseAsync(["list-services", "--json"], { from: "user" });
    expect(stdout).toHaveBeenCalledTimes(1);
    const result = JSON.parse(stdout.mock.calls[0][0]);
    expect(result.services).toEqual(expect.arrayContaining([expect.objectContaining({ name: "resend" })]));
    expect(result).not.toHaveProperty("tokens");
  });

  it("lets the caller collect results, honors config selection, and leaves fresh programs independent", async () => {
    await writeFile(join(directory, "custom.json"), '{"services":{"mail":{"emulator":"resend"}}}');
    const output = vi.fn();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram({ output }).parseAsync(["--json", "list", "--config", "custom.json"], { from: "user" });
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ configuredInstances: [{ name: "mail", source: "resend" }] }),
      expect.stringContaining("Configured instances:\n\n  mail"),
    );
    expect(stdout).not.toHaveBeenCalled();
    await createProgram().parseAsync(["list"], { from: "user" });
    expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/^\nAvailable services:\n\n/));
  });

  it("returns scaffold paths and preserves existing files on a duplicate request", async () => {
    const output = vi.fn();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram({ output }).parseAsync(["init", "--custom", "inventory"], { from: "user" });
    const [result, text] = output.mock.calls[0];
    expect(result).toMatchObject({
      name: "inventory",
      source: join(directory, "emulators/inventory.ts"),
      test: join(directory, "emulators/inventory.test.ts"),
      config: join(directory, "emulate.config.ts"),
      configUpdated: true,
    });
    expect(text).toContain("Start: npx emulate start --watch");
    const before = await readFile(result.config, "utf8");
    expect(() => scaffoldCommand("inventory")).toThrow("already exists");
    expect(await readFile(result.config, "utf8")).toBe(before);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("throws parser and handler errors without exiting or printing a partial result", async () => {
    const output = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("unexpected exit");
    }) as typeof process.exit);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createProgram({ output }).parseAsync(["list", "--unknown"], { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
    await expect(
      createProgram({ output }).parseAsync(["--json", "list", "--config", "missing.json"], { from: "user" }),
    ).rejects.toThrow("Config file not found");
    await expect(
      createProgram({ output }).parseAsync(["start", "--port", "bad-port"], { from: "user" }),
    ).rejects.toThrow("Invalid port: bad-port");
    expect(exit).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("starts in process, reports usable URLs, and gives MCP a repeatable close without global signals", async () => {
    const port = await availablePort();
    const output = vi.fn();
    const started = vi.fn((run: { close(): Promise<void> }) => runs.push(run));
    const sigint = process.listeners("SIGINT");
    const sigterm = process.listeners("SIGTERM");
    await createProgram({ output, started, nonInteractive: true }).parseAsync(
      ["--service", "resend", "--port", String(port)],
      { from: "user" },
    );
    const url = `http://localhost:${port}`;
    expect(output).toHaveBeenCalledWith(
      { ready: true, watching: false, services: [{ name: "resend", url, port, source: "resend" }] },
      expect.stringContaining("Ready."),
    );
    expect((await fetch(`http://127.0.0.1:${port}/emails`)).status).toBe(200);
    expect(started).toHaveBeenCalledTimes(1);
    expect(process.listeners("SIGINT")).toEqual(sigint);
    expect(process.listeners("SIGTERM")).toEqual(sigterm);
    const run = runs[0];
    expect(run.close()).toBe(run.close());
    await run.close();
    await expect(fetch(`http://127.0.0.1:${port}/emails`)).rejects.toThrow();
  });

  it("retains CLI signal ownership and removes handlers when its run is explicitly closed", async () => {
    const port = await availablePort();
    const sigint = process.listeners("SIGINT");
    const sigterm = process.listeners("SIGTERM");
    const { projectStartCommand } = await import("../commands/project-start.js");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const run = await projectStartCommand({ port, service: "resend" });
    runs.push(run);
    expect(process.listenerCount("SIGINT")).toBe(sigint.length + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm.length + 1);
    await run.close();
    expect(process.listeners("SIGINT")).toEqual(sigint);
    expect(process.listeners("SIGTERM")).toEqual(sigterm);
  });

  it("refuses a missing Portless installation without prompting even on a TTY", async () => {
    const originalTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.stubEnv("CI", "");
    vi.stubEnv("PATH", directory);
    try {
      await expect(
        createProgram({ nonInteractive: true }).parseAsync(
          ["start", "--service", "resend", "--portless", "--port", String(await availablePort())],
          { from: "user" },
        ),
      ).rejects.toThrow("portless is required but not installed");
    } finally {
      process.stdin.isTTY = originalTTY;
    }
  });
});
