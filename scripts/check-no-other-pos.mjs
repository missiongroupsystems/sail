#!/usr/bin/env node
// Repo rule: nothing in the repo may name another POS product.
// The forbidden list is kept OUTSIDE the repo (it would itself be a reference).
// Supply it through SAIL_FORBIDDEN_TERMS_FILE (one term per line) when running locally or in CI.
// Without the file, the check passes and prints a notice, so CI stays green on a clean checkout.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const file = process.env.SAIL_FORBIDDEN_TERMS_FILE;
if (!file) {
  console.log("check:no-other-pos: SAIL_FORBIDDEN_TERMS_FILE not set; skipping term scan.");
  process.exit(0);
}
const terms = readFileSync(file, "utf8")
  .split("\n")
  .map((t) => t.trim())
  .filter(Boolean)
  .map((t) => t.toLowerCase());

const skip = new Set(["node_modules", ".git", ".next", "dist", ".turbo", ".pg", "coverage"]);
const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.size < 5_000_000) {
      let text;
      try {
        text = readFileSync(p, "utf8").toLowerCase();
      } catch {
        continue;
      }
      for (const t of terms) if (text.includes(t)) hits.push(`${relative(root, p)}: ${t}`);
    }
  }
}
walk(root);
if (hits.length) {
  console.error("Forbidden product references found:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`check:no-other-pos: clean (${terms.length} terms).`);
