import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * patches/next@15.5.29.patch keeps React's Forked flag through a replay during hydration (patches/README.md). Without
 * it the back office's react-aria ids differ from the server HTML on about one page load in a hundred, which no single
 * test catches reliably; this fails at once if an upgrade or a reinstall drops the patch.
 */
test("the React that Next bundles keeps the Forked flag when it resets a fiber (useId after a replay)", () => {
  const next = dirname(createRequire(resolve(import.meta.dirname, "../../web/package.json")).resolve("next/package.json"));
  const builds = ["react-dom", "react-dom-experimental"].flatMap((channel) => {
    const dir = join(next, "dist/compiled", channel, "cjs");
    return readdirSync(dir).filter((f) => /^react-dom-(client|profiling)\./.test(f)).map((f) => join(dir, f));
  });
  expect(builds.length).toBeGreaterThan(0);
  for (const file of builds) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/\b6501171[24]\b/);
    expect(source, file).toMatch(/\b66060290\b/);
  }
});
