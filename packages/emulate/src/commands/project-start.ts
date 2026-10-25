import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { CommandContext } from "../program.js";
import { ProjectWatcher } from "../project-watcher.js";
import { CONFIG_FILES, findConfig } from "../config-loader.js";
import { prepareProject, type ProjectOptions, type RunMetadata, type RetainedSeed } from "../project-runner.js";
import { ensurePortless, registerAliases, removeAliases, type PortlessAlias } from "../portless.js";
import {
  preflightGeneratedSecretsFile,
  publishGeneratedSecretsFile,
  type PublishedGeneratedSecretsFile,
} from "../generated-secrets-file.js";

function readyResult(metadata: RunMetadata, watching: boolean, machineOutput: boolean) {
  function displayUrl(value: string): string {
    if (!machineOutput) return value;
    try {
      const url = new URL(value);
      const sensitive = [...url.searchParams.keys()].filter((key) =>
        /token|secret|password|credential|signature|session|cookie|(?:api|private)[_-]?key|^(?:auth|authorization|key|code|sig)$/i.test(
          key,
        ),
      );
      if (!url.username && !url.password && !sensitive.length) return value;
      url.username = "";
      url.password = "";
      for (const key of sensitive) url.searchParams.set(key, "[redacted]");
      return url.href;
    } catch {
      return "[redacted]";
    }
  }
  const services = metadata.services.map(({ name, url, port, source, inspectorUrl }) => ({
    name,
    url: displayUrl(url),
    port,
    source,
    ...(inspectorUrl ? { inspectorUrl: displayUrl(inspectorUrl) } : {}),
  }));
  const lines = ["\nemulate\n"];
  for (const service of services) {
    lines.push(`  ${service.name}  ${service.url}\n    Source: ${service.source}`);
    if (service.inspectorUrl)
      lines.push(`    Inspector: ${service.inspectorUrl}\n    Routes: ${service.inspectorUrl}?tab=routes`);
  }
  lines.push(`\n  ${watching ? "Watching imports and fixtures. Reloads reset state to seed." : "Ready."}`);
  return { data: { ready: true, watching, services }, text: lines.join("\n") };
}

function receive(child: ChildProcess, wanted: string, timeout = 30000): Promise<any> {
  return new Promise((resolveMessage, reject) => {
    const cleanup = () => {
      child.off("message", message);
      child.off("exit", exit);
      child.off("error", error);
      clearTimeout(timer);
    };
    const message = (value: any) => {
      if (value.type === wanted) {
        cleanup();
        resolveMessage(value);
      } else if (value.type === "error") {
        cleanup();
        reject(new Error(value.error));
      }
    };
    const exit = (code: number | null) => {
      cleanup();
      reject(new Error(`Emulator runner exited (${code})`));
    };
    const error = (value: Error) => {
      cleanup();
      reject(value);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Emulator runner timed out waiting for ${wanted}`));
    }, timeout);
    child.on("message", message);
    child.once("exit", exit);
    child.once("error", error);
  });
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!child.connected) {
    child.kill("SIGKILL");
    return;
  }
  const done = receive(child, "closed", 7000);
  child.send({ type: "close" }, (error) => {
    if (error) child.kill("SIGKILL");
  });
  try {
    await done;
  } catch (error) {
    child.kill("SIGKILL");
    console.error(error instanceof Error ? error.message : error);
  }
}

export async function projectStartCommand(
  options: ProjectOptions,
  context: CommandContext & { handleSignals?: boolean; diagnosticsToStderr?: boolean } = {},
): Promise<{ close(): Promise<void> }> {
  const output = context.output ?? ((_data: Record<string, unknown>, text: string) => console.log(text));
  const diagnosticsToStderr = context.diagnosticsToStderr ?? Boolean(context.output);
  function manageRun(close: () => Promise<void>) {
    let closing: Promise<void> | undefined;
    const run = {
      close() {
        return (closing ??= Promise.resolve()
          .then(close)
          .finally(() => {
            process.off("SIGINT", shutdown);
            process.off("SIGTERM", shutdown);
          }));
      },
    };
    const shutdown = () => {
      if (closing) return;
      void run
        .close()
        .catch(console.error)
        .finally(() => process.exit(0));
    };
    if (context.handleSignals ?? !(context.started || context.output || context.nonInteractive)) {
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }
    return run;
  }
  async function setupPortless(aliases: PortlessAlias[], signal = context.signal) {
    await ensurePortless({ throwOnFailure: true, nonInteractive: context.nonInteractive });
    signal?.throwIfAborted();
    registerAliases(aliases, diagnosticsToStderr);
  }
  const target = options.generatedSecretsFile
    ? await preflightGeneratedSecretsFile(options.generatedSecretsFile)
    : undefined;
  context.signal?.throwIfAborted();
  let published: PublishedGeneratedSecretsFile | undefined;
  let deliveredSecrets: string | undefined;
  let aliases: PortlessAlias[] = [];
  if (!options.watch) {
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    let preparing: ReturnType<typeof prepareProject> | undefined;
    let publishing: Promise<PublishedGeneratedSecretsFile> | undefined;
    let ready = false;
    const managed = manageRun(async () => {
      controller.abort(new Error("Emulator startup stopped"));
      const run = await preparing?.catch(() => undefined);
      try {
        await run?.close();
      } finally {
        removeAliases(aliases);
        if (!ready) await (await publishing)?.rollback();
      }
    });
    try {
      signal.throwIfAborted();
      context.started?.(managed);
      const run = await (preparing = prepareProject(options, {}, false, undefined, signal));
      signal.throwIfAborted();
      if (target)
        published = await (publishing = publishGeneratedSecretsFile(target, {
          schemaVersion: 1,
          generatedSecrets: run.metadata.secrets,
        }));
      signal.throwIfAborted();
      if (options.portless) {
        await setupPortless(run.metadata.aliases, signal);
        aliases = run.metadata.aliases;
      }
      await run.start();
      signal.throwIfAborted();
      ready = true;
      const result = readyResult(run.metadata, false, diagnosticsToStderr);
      output(result.data, result.text);
      return managed;
    } catch (error) {
      await managed.close().catch(console.error);
      await published?.rollback();
      throw error;
    }
  }
  const configPath = findConfig(options.config ?? options.seed);
  const directory = configPath ? dirname(configPath) : process.cwd();
  const configCandidates = options.config || options.seed ? [] : CONFIG_FILES.map((name) => resolve(directory, name));
  let worker: ChildProcess | undefined;
  let candidate: ChildProcess | undefined;
  let retained: Record<string, RetainedSeed> = {};
  let dependencies = new Set<string>([...configCandidates, ...(configPath ? [configPath] : [])]);
  // A new worker has not executed lazy route imports yet. Keep watching files discovered by earlier generations.
  const lazyDependencies = new Set<string>();
  let patterns: string[] = [];
  let successful = false;
  let failed = false;
  let stopped = false;
  let queued = false;
  let loading = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let activeReload: Promise<void> | undefined;
  let currentServices: ReturnType<typeof readyResult>["data"]["services"] = [];
  function queueReload(): Promise<void> {
    if (loading) {
      queued = true;
      return activeReload!;
    }
    return (activeReload = reload());
  }
  async function reload() {
    if (stopped) return;
    loading = true;
    const attemptedDependencies = new Set<string>();
    let candidateProcess: ChildProcess | undefined;
    const trackCandidateDependencies = (message: any) => {
      if (message.type === "dependencies")
        for (const file of message.dependencies as string[]) attemptedDependencies.add(file);
    };
    try {
      candidate = fork(fileURLToPath(new URL("./project-worker.js", import.meta.url)), [], {
        execArgv: ["--enable-source-maps"],
        stdio: ["ignore", diagnosticsToStderr ? process.stderr : "inherit", "inherit", "ipc"],
      });
      candidateProcess = candidate;
      candidate.on("message", trackCandidateDependencies);
      const prepared = receive(candidate, "prepared");
      candidate.send({ type: "prepare", options, retained, reload: successful });
      const { metadata } = (await prepared) as { metadata: RunMetadata };
      if (stopped) return;
      const secretsIdentity = JSON.stringify(metadata.secrets.map((secret) => JSON.stringify(secret)).sort());
      if (published && deliveredSecrets !== secretsIdentity)
        throw new Error(
          "Generated identities changed. Restart with a new --generated-secrets-file path to apply the change.",
        );
      if (target && !published) {
        published = await publishGeneratedSecretsFile(target, { schemaVersion: 1, generatedSecrets: metadata.secrets });
        deliveredSecrets = secretsIdentity;
      }
      await stop(worker);
      worker = undefined;
      if (stopped) return;
      removeAliases(aliases);
      aliases = [];
      if (options.portless) {
        await setupPortless(metadata.aliases);
        if (stopped) {
          removeAliases(metadata.aliases);
          return;
        }
        aliases = metadata.aliases;
      }
      const started = receive(candidate, "started");
      candidate.send({ type: "start" });
      await started;
      if (stopped) return;
      worker = candidate;
      candidate = undefined;
      dependencies = new Set([...configCandidates, ...metadata.dependencies, ...lazyDependencies]);
      patterns = metadata.watch.map((pattern) => resolve(directory, pattern));
      const running = worker;
      running.on("message", (message: any) => {
        if (worker !== running || stopped || message.type !== "dependencies") return;
        for (const file of message.dependencies as string[]) {
          if (!metadata.dependencies.includes(file)) lazyDependencies.add(file);
        }
        dependencies = new Set([...configCandidates, ...metadata.dependencies, ...lazyDependencies]);
        void watcher.update(dependencies, patterns, failed).catch(console.error);
      });
      running.once("exit", (code, signal) => {
        if (worker !== running || stopped) return;
        worker = undefined;
        failed = true;
        void watcher.update(dependencies, patterns, true).catch(console.error);
        removeAliases(aliases);
        aliases = [];
        const error = `Emulator runner exited (${signal ?? code}). Save a source file to restart.`;
        console.error(error);
        currentServices = [];
        if (diagnosticsToStderr) output({ ready: false, watching: true, services: [], error }, error);
      });
      retained = metadata.retained;
      failed = false;
      await watcher.update(dependencies, patterns, false);
      if (stopped) return;
      successful = true;
      const result = readyResult(metadata, true, diagnosticsToStderr);
      currentServices = result.data.services;
      output(result.data, result.text);
    } catch (error) {
      if (stopped) return;
      failed = true;
      dependencies = new Set([...dependencies, ...attemptedDependencies]);
      await watcher.update(dependencies, patterns, true);
      const message = `\nReload failed${worker ? "; serving the last successful version" : ""}. Fix the source and save to retry.\n${error instanceof Error ? error.message : error}`;
      console.error(message);
      if (diagnosticsToStderr)
        output(
          {
            ready: Boolean(worker),
            watching: true,
            services: worker ? currentServices : [],
            error: error instanceof Error ? error.message : String(error),
          },
          message,
        );
      await stop(candidate);
      candidate = undefined;
      if (!worker) {
        removeAliases(aliases);
        aliases = [];
      }
      if (!successful) {
        await published?.rollback();
        published = undefined;
        deliveredSecrets = undefined;
      }
    } finally {
      candidateProcess?.off("message", trackCandidateDependencies);
      loading = false;
      if (queued && !stopped) {
        queued = false;
        void queueReload();
      }
    }
  }
  const watcher = new ProjectWatcher(
    directory,
    (path) => {
      if (stopped || (options.generatedSecretsFile && path === resolve(options.generatedSecretsFile))) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void queueReload();
      }, 100);
    },
    (error) => console.error("Watch error:", error),
  );
  const run = manageRun(async () => {
    stopped = true;
    clearTimeout(debounce);
    try {
      const results = await Promise.allSettled([watcher.close(), stop(worker), stop(candidate)]);
      await activeReload;
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "Failed to shut down watch",
        );
    } finally {
      removeAliases(aliases);
      if (!successful) await published?.rollback();
    }
  });
  try {
    context.started?.(run);
    await watcher.start();
    if (!stopped) await queueReload();
    return run;
  } catch (error) {
    await run.close().catch(console.error);
    throw error;
  }
}
