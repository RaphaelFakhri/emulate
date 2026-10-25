import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";
import { initCommand } from "../commands/init.js";
import { listCommand } from "../commands/list.js";

let directory: string;
let previousDirectory: string;

beforeEach(async () => {
  previousDirectory = process.cwd();
  directory = await realpath(await mkdtemp(join(tmpdir(), "emulate-commands-")));
  vi.stubEnv("EMULATE_BASE_URL", "");
  vi.stubEnv("PORTLESS_URL", "");
  process.chdir(directory);
});

afterEach(async () => {
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
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await createProgram().parseAsync(["list-services", "--json"], { from: "user" });
    expect(write).toHaveBeenCalledTimes(1);
    const result = JSON.parse(String(write.mock.calls[0][0]));
    expect(result.services).toEqual(expect.arrayContaining([expect.objectContaining({ name: "resend" })]));
    expect(result).not.toHaveProperty("tokens");
  });

  it("returns structured scaffold paths without printing", async () => {
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
    expect(stdout).not.toHaveBeenCalled();
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
