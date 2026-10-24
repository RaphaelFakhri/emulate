import { CommanderError } from "commander";
import { createProgram } from "./program.js";

const write = process.stdout.write.bind(process.stdout);
const program = createProgram();
program.hook("preAction", (_program, command) => {
  if (program.opts().json && command.name() !== "mcp")
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
});

program
  .command("mcp")
  .description("Start the MCP server over stdio")
  .action(async () => {
    await (await import("./mcp.js")).startMcpServer();
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
