import { CommanderError } from "commander";
import { createProgram } from "./program.js";

const write = process.stdout.write.bind(process.stdout);
const program = createProgram();
program.hook("preAction", () => {
  if (program.opts().json)
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
});

try {
  await program.parseAsync();
} catch (error) {
  const exitCode = error instanceof CommanderError ? error.exitCode : 1;
  if (exitCode) {
    const message = error instanceof Error ? error.message : String(error);
    if (program.opts().json) write(`${JSON.stringify({ error: message })}\n`);
    else console.error(message);
  }
  process.exitCode = exitCode;
}
