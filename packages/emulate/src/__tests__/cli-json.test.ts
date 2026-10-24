import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
