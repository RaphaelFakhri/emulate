import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStartCommand } from "../commands/project-start.js";
import type { RunMetadata } from "../project-runner.js";
import * as secretsFile from "../generated-secrets-file.js";

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  change: undefined as undefined | ((path: string) => void),
  start: vi.fn(async () => {}),
  update: vi.fn(async (_files: Iterable<string>, _patterns: string[], _recovery: boolean) => {}),
  close: vi.fn(async () => {}),
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
function metadata(): RunMetadata {
  return {
    services: [{ name: "mail", url: "http://localhost:4000", port: 4000, source: "resend" }],
    dependencies: ["/tmp/emulate-watch/config.json"],
    directory: "/tmp/emulate-watch",
    watch: [],
    aliases: [],
    secrets: [{ service: "github", kind: "key", id: "1", label: "App", value: "private-value" }],
    retained: { mail: { emulator: "resend", input: "{}", config: { token: "private-value" }, secrets: [] } },
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.close()));
  vi.restoreAllMocks();
});

it.each(["start", "watch", "watch-ready"])("rolls back secrets when stopped before readiness: %s", async (mode) => {
  const watch = mode !== "start";
  const controller = new AbortController();
  mocks.fork.mockReturnValue(new Worker(metadata()));
  let resumeWatch!: () => void;
  if (mode === "watch-ready")
    mocks.update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resumeWatch = resolve;
        }),
    );
  vi.spyOn(secretsFile, "preflightGeneratedSecretsFile").mockResolvedValue({
    path: "/tmp/stopped-secrets.json",
    parent: "/tmp",
    platform: "linux",
  });
  let publish!: (file: secretsFile.PublishedGeneratedSecretsFile) => void;
  vi.spyOn(secretsFile, "publishGeneratedSecretsFile").mockReturnValue(
    new Promise((resolve) => {
      publish = resolve;
    }),
  );
  let owned!: (run: { close(): Promise<void> }) => void;
  const ownership = new Promise<{ close(): Promise<void> }>((resolve) => {
    owned = resolve;
  });
  const starting = projectStartCommand(
    { port: 4000, service: "resend", watch, generatedSecretsFile: "/tmp/stopped-secrets.json" },
    { signal: controller.signal, started: owned },
  ).catch((error) => error);
  const run = await ownership;
  runs.push(run);
  await vi.waitFor(() => expect(secretsFile.publishGeneratedSecretsFile).toHaveBeenCalledOnce());
  let artifactExists = true;
  const artifact = {
    path: "/tmp/stopped-secrets.json",
    identity: { dev: 1n, ino: 1n },
    rollback: async () => {
      artifactExists = false;
    },
  };
  if (mode === "watch-ready") {
    publish(artifact);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
  }
  const stopped = new Error("startup stopped");
  controller.abort(stopped);
  let closed = false;
  const closing = run.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally {
    if (mode === "watch-ready") resumeWatch();
    else publish(artifact);
  }
  await closing;
  expect(artifactExists).toBe(false);
  if (watch) expect(await starting).toBe(run);
  else expect(await starting).toBe(stopped);
});

describe("embedded watch lifecycle", () => {
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
});
