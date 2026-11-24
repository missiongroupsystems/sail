import assert from "node:assert/strict";
import { test } from "node:test";
import { initialIcon, PRODUCT_ICON, PRODUCT_MARK, PRODUCT_NAME } from "./brand";
import { checkExtensionPages, extensionPage, extensionSectionPage, pageMinRole, RAIL, SECTIONS } from "./nav";

// Run with test/tsconfig.extension.json, which maps @sail/extensions to test/extension.
test("an extension's sections follow Sail's, each with its page's role", () => {
  assert.deepEqual(RAIL.slice(0, SECTIONS.length), SECTIONS);
  assert.deepEqual(
    RAIL.slice(SECTIONS.length).map((s) => [s.href, s.label, s.minRole]),
    [
      ["/x/open", "Open", "server"],
      ["/x/managers", "Managers", "manager"],
      ["/x/admins/only/?tab=week", "Admins", "admin"],
    ],
  );
});

test("an extension page names its role for the refusal page, with or without a rail section", () => {
  assert.equal(pageMinRole("/x/open"), "server");
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

test("a brand without an icon of its own gets its initial, never the sail", () => {
  assert.equal(PRODUCT_ICON, "/brand-icon.svg");
  assert.match(initialIcon("harbour"), />H<\/text><\/svg>$/);
  assert.match(initialIcon("& Co"), />&#38;<\/text>/);
  assert.doesNotMatch(initialIcon("Harbour"), /M118 392/);
});

test("a rail section's page is found without its query, hash or trailing slash", () => {
  assert.equal(extensionSectionPage("/x/managers/"), "managers");
  assert.equal(extensionSectionPage("/x/managers?tab=1"), "managers");
  assert.equal(extensionSectionPage("/x/admins/only/#top"), "admins/only");
  assert.equal(extensionSectionPage("/today"), undefined);
});

test("a page without a known role is refused, not opened to everyone", () => {
  assert.throws(() => checkExtensionPages({ open: {} }), /SAIL_EXTENSIONS: page "open" needs a minRole/);
  assert.throws(() => checkExtensionPages({ odd: { minRole: "owner" } }), /page "odd" needs a minRole/);
  assert.doesNotThrow(() => checkExtensionPages({ ok: { minRole: "server" } }));
});
