import assert from "node:assert/strict";
import { test } from "node:test";
import extensions from "@sail/extensions";
import { PRODUCT_ICON, PRODUCT_MARK, PRODUCT_NAME } from "./brand";
import { extensionPage, pageMinRole, RAIL, SECTIONS } from "./nav";

// Stock Sail (no SAIL_EXTENSIONS): the rail, the pages and the product name are Sail's own.
test("with no extensions, the rail is Sail's sections, unchanged", () => {
  assert.deepEqual(extensions, {});
  assert.deepEqual(
    RAIL.map((s) => s.href),
    ["/today", "/orders", "/menu", "/pricing", "/floor", "/printing", "/team", "/reports", "/audit", "/settings"],
  );
  assert.deepEqual(RAIL, SECTIONS);
});

test("with no extensions, there are no /x/ pages and Sail's pages keep their roles", () => {
  assert.equal(extensionPage("hello"), undefined);
  assert.equal(pageMinRole("/x/hello"), null);
  assert.equal(pageMinRole("/team"), "manager");
  assert.equal(pageMinRole("/menu/import"), "admin");
});

test("with no extensions, the product is Sail with the sail mark", () => {
  assert.equal(PRODUCT_NAME, "Sail");
  assert.equal(PRODUCT_MARK, undefined);
  assert.equal(PRODUCT_ICON, undefined);
});
