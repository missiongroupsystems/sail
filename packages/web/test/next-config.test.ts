import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

/** next.config.ts as Next loads it, run from another folder: the modules its webpack plugins put in for @sail/extensions. */
function swapped(env: Record<string, string>): string[] {
  const script = `
    const loadConfig = require(require.resolve("next/dist/server/config", { paths: [${JSON.stringify(web)}] })).default;
    loadConfig("phase-production-build", ${JSON.stringify(web)}).then((c) => {
      const cfg = { plugins: [] };
      c.webpack(cfg, { webpack: { NormalModuleReplacementPlugin: class { constructor(_, to) { this.to = to; } } } });
      console.log(JSON.stringify(cfg.plugins.map((p) => p.to)));
    }, (e) => { console.log(JSON.stringify({ error: e.message })); });`;
  const { SAIL_EXTENSIONS: _s, TURBOPACK: _t, ...rest } = process.env;
  const out = execFileSync(process.execPath, ["-e", script], { cwd: tmpdir(), env: { ...rest, ...env }, encoding: "utf8" });
  const parsed = JSON.parse(out.trim().split("\n").at(-1)!) as string[] | { error: string };
  if (!Array.isArray(parsed)) throw new Error(parsed.error);
  return parsed;
}

test("with no SAIL_EXTENSIONS, Sail's empty extensions are used", () => {
  assert.deepEqual(swapped({}), [join(web, "src/extensions/none/index"), join(web, "src/extensions/none/pages")]);
});

test("a relative SAIL_EXTENSIONS is read from the web package's folder, not the current one", () => {
  assert.deepEqual(swapped({ SAIL_EXTENSIONS: "test/extension" }), [join(web, "test/extension/index"), join(web, "test/extension/pages")]);
});

test("an absolute SAIL_EXTENSIONS is kept", () => {
  assert.deepEqual(swapped({ SAIL_EXTENSIONS: "/srv/ext" }), ["/srv/ext/index", "/srv/ext/pages"]);
});

test("SAIL_EXTENSIONS with Turbopack stops the build instead of building stock Sail", () => {
  assert.throws(() => swapped({ SAIL_EXTENSIONS: "test/extension", TURBOPACK: "1" }), /needs the webpack build/);
});
