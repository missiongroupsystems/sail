import assert from "node:assert/strict";
import { test } from "node:test";
import extensions from "@sail/extensions";
import { PRODUCT_NAME, RAIL, SECTIONS } from "./nav";

// Stock Sail (no SAIL_EXTENSIONS): the rail and the product name are Sail's own.
test("with no extensions, the rail is Sail's sections in order", () => {
  assert.deepEqual(extensions, {});
  assert.deepEqual(
    RAIL.map((s) => s.href),
    ["/today", "/orders", "/menu", "/pricing", "/floor", "/printing", "/team", "/reports", "/audit", "/settings"],
  );
  assert.equal(RAIL.length, SECTIONS.length);
});

test("with no extensions, the product is named Sail", () => {
  assert.equal(PRODUCT_NAME, "Sail");
});
