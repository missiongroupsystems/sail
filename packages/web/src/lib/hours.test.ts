import assert from "node:assert/strict";
import { test } from "node:test";
import { newOutletHours } from "./hours";

const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
const late = { ...closed, fri: [["18:00", "02:00"]], sat: [["18:00", "02:00"]] };
const main = { ...closed, mon: [["11:00", "22:00"]], sun: [["10:00", "16:00"]] };

test("a new outlet starts from the hours of the brand's first outlet that opens", () => {
  const form = newOutletHours([{ brand_id: "x", hours: late }, { brand_id: "b", hours: closed }, { brand_id: "b", hours: main }], "b");
  assert.deepEqual(form.mon, { open: true, from: "11:00", to: "22:00" });
  assert.deepEqual(form.sun, { open: true, from: "10:00", to: "16:00" });
  assert.equal(form.tue.open, false);
});

test("no outlet of the brand opens: another brand's; an archived outlet is never the model", () => {
  assert.deepEqual(newOutletHours([{ brand_id: "b", hours: main, archived: true }, { brand_id: "x", hours: late }], "b").fri, { open: true, from: "18:00", to: "02:00" });
});

test("no outlet that opens: every day open, never closed all week", () => {
  const form = newOutletHours([{ brand_id: "b", hours: closed }], "b");
  for (const day of Object.values(form)) assert.equal(day.open, true);
});
