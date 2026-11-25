import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The app's stylesheet through postcss.config.mjs, as the build runs it. */
function css(env: Record<string, string>): string {
  const script = `
    const { createRequire } = require("node:module");
    const tw = require.resolve("@tailwindcss/postcss", { paths: [${JSON.stringify(web)}] });
    const postcss = createRequire(tw)("postcss");
    import(${JSON.stringify(join(web, "postcss.config.mjs"))}).then(async ({ default: cfg }) => {
      const plugins = Object.entries(cfg.plugins).map(([name, opts]) => { const m = require(require.resolve(name, { paths: [${JSON.stringify(web)}] })); return (m.default ?? m)(opts); });
      const from = ${JSON.stringify(join(web, "src/app/globals.css"))};
      const out = await postcss(plugins).process(require("node:fs").readFileSync(from, "utf8"), { from });
      process.stdout.write(out.css);
    });`;
  const { SAIL_EXTENSIONS: _s, ...rest } = process.env;
  return execFileSync(process.execPath, ["-e", script], { cwd: web, env: { ...rest, ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
}

test("Tailwind generates the classes of the SAIL_EXTENSIONS folder, also outside the web package", () => {
  const dir = mkdtempSync(join(tmpdir(), "sail-ext-"));
  try {
    // Built here so this file, which Tailwind scans as part of the web package, does not hold the class itself.
    const cls = ["tracking-[0", "731em]"].join(".");
    writeFileSync(join(dir, "index.tsx"), `export const Page = () => <p className="${cls}" />;\n`);
    assert.doesNotMatch(css({}), /\.731em/);
    assert.match(css({ SAIL_EXTENSIONS: dir }), /letter-spacing:\s*0?\.731em/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no SAIL_EXTENSIONS, the stylesheet adds no source", () => {
  assert.doesNotMatch(readFileSync(join(web, "postcss.config.mjs"), "utf8") + css({}), /sail-ext-/);
});
