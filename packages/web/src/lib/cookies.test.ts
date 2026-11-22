import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_SCOPE, resolveScope } from "./cookies";

const alpha = { id: "b-alpha", name: "Alpha" };
const zest = { id: "b-zest", name: "Zest" };
const old = { id: "b-old", name: "Aardvark", archived: true };
const zestDock = { id: "o-dock", brand_id: zest.id };
const zestPier = { id: "o-pier", brand_id: zest.id };
const alphaMain = { id: "o-main", brand_id: alpha.id };

test("nothing remembered: the first brand by name that owns a visible outlet, not the first by name", () => {
  assert.deepEqual(resolveScope(EMPTY_SCOPE, [alpha, zest], [zestDock]), { brandId: zest.id, outletId: null });
});

test("a remembered brand that owns no visible outlet falls back to one that does", () => {
  assert.deepEqual(resolveScope({ brandId: alpha.id, outletId: alphaMain.id }, [alpha, zest], [zestDock, zestPier]), { brandId: zest.id, outletId: null });
});

test("a remembered brand in reach keeps its remembered outlet", () => {
  assert.deepEqual(resolveScope({ brandId: zest.id, outletId: zestPier.id }, [alpha, zest], [alphaMain, zestDock, zestPier]), { brandId: zest.id, outletId: zestPier.id });
});

test("an archived brand is never chosen, even when it owns a visible outlet", () => {
  assert.deepEqual(resolveScope({ brandId: old.id, outletId: null }, [old, zest], [{ id: "o-x", brand_id: old.id }, zestDock]), { brandId: zest.id, outletId: null });
});

test("another brand's outlet or an archived outlet does not stick", () => {
  assert.deepEqual(resolveScope({ brandId: zest.id, outletId: alphaMain.id }, [alpha, zest], [alphaMain, zestDock]), { brandId: zest.id, outletId: null });
  assert.deepEqual(resolveScope({ brandId: zest.id, outletId: "o-gone" }, [zest], [zestDock, { id: "o-gone", brand_id: zest.id, archived: true }]), { brandId: zest.id, outletId: null });
});

test("a merchant with no outlet yet still has its brand in scope", () => {
  assert.deepEqual(resolveScope(EMPTY_SCOPE, [zest, alpha], []), { brandId: alpha.id, outletId: null });
});

test("no live brand in reach: an empty scope", () => {
  assert.deepEqual(resolveScope(EMPTY_SCOPE, [], [zestDock]), EMPTY_SCOPE);
  assert.deepEqual(resolveScope(EMPTY_SCOPE, [old], []), EMPTY_SCOPE);
});
