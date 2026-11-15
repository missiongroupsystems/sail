// Runs a dev server for the end-to-end suite and keeps its output: stdout and stderr go to
// test-results/servers/<name>.log (CI uploads test-results when a run fails), and stderr also to this process's stderr,
// which Playwright shows. Usage: node scripts/with-log.mjs <name> <command...>
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [name, ...command] = process.argv.slice(2);
if (!name || command.length === 0) {
  console.error("usage: with-log.mjs <name> <command...>");
  process.exit(2);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "servers");
mkdirSync(dir, { recursive: true });
const log = createWriteStream(join(dir, `${name}.log`), { flags: "a" });
log.write(`\n--- ${new Date().toISOString()} start: ${command.join(" ")}\n`);

const child = spawn(command.join(" "), { shell: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(log, { end: false });
child.stderr.on("data", (chunk) => {
  log.write(chunk);
  process.stderr.write(chunk);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("close", (code, signal) => {
  log.end(`--- ${new Date().toISOString()} exit: ${signal ?? code}\n`, () => process.exit(code ?? 1));
});
