import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_SCOPE, followLink, keepShownOutlet, resolveScope } from "./cookies";

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

test("a link to an outlet of another brand takes the scope to that outlet and its brand", () => {
  assert.deepEqual(followLink({ brandId: alpha.id, outletId: null }, zestPier.id, [alpha, zest], [alphaMain, zestDock, zestPier]), { brandId: zest.id, outletId: zestPier.id });
});

test("a link's outlet the person cannot see, archived, on an archived brand, or of the brand in scope leaves the scope as it is", () => {
  const scope = { brandId: alpha.id, outletId: null };
  assert.equal(followLink(scope, null, [alpha, zest], [alphaMain, zestDock]), scope);
  assert.equal(followLink(scope, "o-unseen", [alpha, zest], [alphaMain, zestDock]), scope);
  assert.equal(followLink(scope, "o-gone", [alpha, zest], [alphaMain, { id: "o-gone", brand_id: zest.id, archived: true }]), scope);
  assert.equal(followLink(scope, "o-x", [alpha, old], [alphaMain, { id: "o-x", brand_id: old.id }]), scope);
  assert.equal(followLink(scope, alphaMain.id, [alpha, zest], [alphaMain, zestDock]), scope);
});

test("adding an outlet while nothing is remembered keeps the outlet the pages were showing", () => {
  const scope = { brandId: zest.id, outletId: null };
  assert.deepEqual(keepShownOutlet(scope, [{ ...zestPier, archived: true }, zestDock], { brand_id: zest.id }), { brandId: zest.id, outletId: zestDock.id });
  assert.equal(keepShownOutlet({ brandId: zest.id, outletId: zestPier.id }, [zestDock, zestPier], { brand_id: zest.id }), null);
  assert.equal(keepShownOutlet(scope, [zestDock], { brand_id: alpha.id }), null);
  assert.equal(keepShownOutlet(scope, [], { brand_id: zest.id }), null);
});

test("someone who sees every outlet can put a new brand with no outlet yet in scope; someone limited to some outlets cannot", () => {
  assert.deepEqual(resolveScope({ brandId: alpha.id, outletId: null }, [alpha, zest], [zestDock], true), { brandId: alpha.id, outletId: null });
  assert.deepEqual(resolveScope({ brandId: alpha.id, outletId: null }, [alpha, zest], [zestDock], false), { brandId: zest.id, outletId: null });
  // Nothing remembered still starts on a brand that has outlets.
  assert.equal(resolveScope(EMPTY_SCOPE, [alpha, zest], [zestDock], true).brandId, zest.id);
});
