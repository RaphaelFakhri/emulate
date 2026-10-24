import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStartCommand } from "../commands/project-start.js";
import type { RunMetadata } from "../project-runner.js";

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  change: undefined as undefined | ((path: string) => void),
  start: vi.fn(async () => {}),
  update: vi.fn(async (_files: Iterable<string>, _patterns: string[], _recovery: boolean) => {}),
  close: vi.fn(async () => {}),
  rollback: vi.fn(async () => {}),
  publish: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: mocks.fork,
}));
vi.mock("../project-watcher.js", () => ({
  ProjectWatcher: class {
    constructor(_directory: string, change: (path: string) => void) {
      mocks.change = change;
    }
    start = mocks.start;
    update = mocks.update;
    close = mocks.close;
  },
}));
vi.mock("../generated-secrets-file.js", () => ({
  preflightGeneratedSecretsFile: vi.fn(async () => ({})),
  publishGeneratedSecretsFile: mocks.publish,
}));

function metadata(secret = "private-value"): RunMetadata {
  return {
    services: [{ name: "mail", url: "http://localhost:4000", port: 4000, source: "resend" }],
    dependencies: ["/tmp/emulate-watch/config.json"],
    directory: "/tmp/emulate-watch",
    watch: [],
    aliases: [],
    secrets: [{ service: "github", kind: "key", id: "1", label: "App", value: secret }],
    retained: { mail: { emulator: "resend", input: "{}", config: { token: secret }, secrets: [] } },
  };
}

class Worker extends EventEmitter {
  exitCode: number | null = null;
  signalCode = null;
  connected = true;
  send = vi.fn((message: { type: string }, callback?: (error: null) => void) => {
    queueMicrotask(() => {
      if (message.type === "close") {
        this.connected = false;
        this.exitCode = 0;
        this.emit("message", { type: "closed" });
        this.emit("exit", 0);
      } else if (message.type === "prepare") {
        if (this.error) {
          this.emit("message", { type: "dependencies", dependencies: ["/tmp/emulate-watch/missing.ts"] });
          this.emit("message", { type: "error", error: this.error });
        } else this.emit("message", { type: "prepared", metadata: this.metadata });
      } else if (message.type === "start") this.emit("message", { type: "started" });
      callback?.(null);
    });
    return true;
  });
  kill = vi.fn(() => true);

  constructor(
    readonly metadata: RunMetadata,
    readonly error?: string,
  ) {
    super();
  }
}

const runs: Array<{ close(): Promise<void> }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.publish.mockResolvedValue({ rollback: mocks.rollback });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.close()));
  vi.restoreAllMocks();
});

describe("embedded watch lifecycle", () => {
  it("keeps worker diagnostics off stdout and closes the worker and watcher without installing signals", async () => {
    const worker = new Worker(metadata());
    mocks.fork.mockReturnValue(worker);
    const output = vi.fn();
    const started = vi.fn();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const sigint = process.listeners("SIGINT");
    const sigterm = process.listeners("SIGTERM");
    const run = await projectStartCommand({ port: 4000, watch: true }, { output, started, nonInteractive: true });
    runs.push(run);
    expect(started).toHaveBeenCalledWith(run);
    expect(output).toHaveBeenCalledWith(
      { ready: true, watching: true, services: worker.metadata.services },
      expect.stringContaining("Watching imports and fixtures."),
    );
    expect(JSON.stringify(output.mock.calls)).not.toContain("private-value");
    expect(mocks.fork.mock.calls[0][2].stdio).toEqual(["ignore", process.stderr, "inherit", "ipc"]);
    expect(process.listeners("SIGINT")).toEqual(sigint);
    expect(process.listeners("SIGTERM")).toEqual(sigterm);
    expect(stdout).not.toHaveBeenCalled();
    expect(run.close()).toBe(run.close());
    await run.close();
    expect(worker.send.mock.calls.filter(([message]) => message.type === "close")).toHaveLength(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("preserves raw CLI worker output and readiness text", async () => {
    const worker = new Worker(metadata());
    mocks.fork.mockReturnValue(worker);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = await projectStartCommand({ port: 4000, watch: true });
    runs.push(run);
    expect(mocks.fork.mock.calls[0][2].stdio).toEqual(["ignore", "inherit", "inherit", "ipc"]);
    expect(stdout.mock.calls).toEqual([
      [
        "\nemulate\n\n  mail  http://localhost:4000\n    Source: resend\n\n  Watching imports and fixtures. Reloads reset state to seed.",
      ],
    ]);
  });

  it("reports a failed initial load and recovers when a missing dependency is created", async () => {
    const broken = new Worker(metadata(), "Missing import");
    const recovered = new Worker(metadata());
    mocks.fork.mockReturnValueOnce(broken).mockReturnValueOnce(recovered);
    const output = vi.fn();
    const run = await projectStartCommand({ port: 4000, watch: true }, { output, nonInteractive: true });
    runs.push(run);
    expect(output).toHaveBeenLastCalledWith(
      { ready: false, watching: true, services: [], error: "Missing import" },
      expect.stringContaining("Fix the source and save to retry"),
    );
    expect(mocks.update).toHaveBeenCalledWith(expect.any(Set), [], true);
    expect([...mocks.update.mock.calls[0][0]]).toContain("/tmp/emulate-watch/missing.ts");
    mocks.change?.("/tmp/emulate-watch/missing.ts");
    await vi.waitFor(() =>
      expect(output).toHaveBeenLastCalledWith(
        expect.objectContaining({ ready: true, services: recovered.metadata.services }),
        expect.stringContaining("Watching imports"),
      ),
    );
    expect(broken.connected).toBe(false);
  });

  it("retains the working runner and generated identities when a reload would change secrets", async () => {
    const first = new Worker(metadata());
    const changed = new Worker(metadata("changed-private-value"));
    const next = new Worker(metadata());
    mocks.fork.mockReturnValueOnce(first).mockReturnValueOnce(changed).mockReturnValueOnce(next);
    const output = vi.fn();
    const run = await projectStartCommand(
      { port: 4000, watch: true, generatedSecretsFile: "/tmp/emulate-secrets.json" },
      { output, nonInteractive: true },
    );
    runs.push(run);
    mocks.change?.("/tmp/emulate-watch/config.json");
    await vi.waitFor(() =>
      expect(output).toHaveBeenLastCalledWith(
        expect.objectContaining({ ready: true, error: expect.stringContaining("Generated identities changed") }),
        expect.stringContaining("serving the last successful version"),
      ),
    );
    expect(first.connected).toBe(true);
    expect(changed.connected).toBe(false);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.rollback).not.toHaveBeenCalled();
    mocks.change?.("/tmp/emulate-watch/config.json");
    await vi.waitFor(() =>
      expect(output).toHaveBeenLastCalledWith(
        expect.objectContaining({ ready: true, services: next.metadata.services }),
        expect.stringContaining("Watching imports"),
      ),
    );
    expect(next.send).toHaveBeenCalledWith(expect.objectContaining({ retained: first.metadata.retained }));
    expect(first.connected).toBe(false);
    expect(JSON.stringify(output.mock.calls)).not.toContain("private-value");
  });
});
