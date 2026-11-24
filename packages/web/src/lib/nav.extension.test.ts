import assert from "node:assert/strict";
import { test } from "node:test";
import { PRODUCT_MARK, PRODUCT_NAME } from "./brand";
import { extensionPage, pageMinRole, RAIL, SECTIONS } from "./nav";

// Run with test/tsconfig.extension.json, which maps @sail/extensions to test/extension.
test("an extension's sections follow Sail's, each with its page's role", () => {
  assert.deepEqual(RAIL.slice(0, SECTIONS.length), SECTIONS);
  assert.deepEqual(
    RAIL.slice(SECTIONS.length).map((s) => [s.href, s.label, s.minRole]),
    [
      ["/x/open", "Open", undefined],
      ["/x/managers", "Managers", "manager"],
    ],
  );
});

test("an extension page names its role for the refusal page, with or without a rail section", () => {
  assert.equal(pageMinRole("/x/open"), null);
  assert.equal(pageMinRole("/x/managers"), "manager");
  assert.equal(pageMinRole("/x/admins/only"), "admin");
  assert.equal(pageMinRole("/x/missing"), null);
  assert.equal(pageMinRole("/team"), "manager");
});

test("an extension page is found by its own path only", () => {
  assert.equal(extensionPage("missing"), undefined);
  assert.equal(extensionPage("toString"), undefined);
  assert.deepEqual(extensionPage("admins/only"), { minRole: "admin" });
});

test("an extension's brand replaces the product name and mark", () => {
  assert.equal(PRODUCT_NAME, "Harbour");
  assert.equal(typeof PRODUCT_MARK, "function");
});
