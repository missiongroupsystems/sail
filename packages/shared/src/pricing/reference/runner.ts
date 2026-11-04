import { expect } from "vitest";
import { price } from "../engine.js";
import { sumCents } from "../../money.js";
import type { RefCase } from "./dsl.js";

/** Runs one reference case: asserts its hand-calculated expectations and the universal invariants. */
export function runRefCase(c: RefCase) {
  const r = price(c.order, c.rules, c.context);
  const key = (a: { rule_id: string; manual_application_id: string | null }) => (a.manual_application_id ? `${a.rule_id}#${a.manual_application_id}` : a.rule_id);
  const totals = Object.fromEntries(r.adjustments.map((a) => [key(a), a.total]));
  const e = c.expect;

  if (e.adjustments) {
    for (const [k, v] of Object.entries(e.adjustments)) expect(totals[k], `${c.id} adjustment ${k}`).toBe(v);
  }
  if (e.adjustment_lines) {
    for (const [k, lines] of Object.entries(e.adjustment_lines)) {
      const adj = r.adjustments.find((a) => key(a) === k);
      expect(adj, `${c.id} adjustment ${k} present`).toBeDefined();
      const got = Object.fromEntries(adj!.lines.map((l) => [l.line_id, l.amount]));
      for (const [lineId, amt] of Object.entries(lines)) expect(got[lineId], `${c.id} ${k} line ${lineId}`).toBe(amt);
    }
  }
  const byLine = Object.fromEntries(r.lines.map((l) => [l.line_id, l]));
  if (e.line_nets) for (const [id, v] of Object.entries(e.line_nets)) expect(byLine[id]?.net_amount, `${c.id} net ${id}`).toBe(v);
  if (e.line_fees) for (const [id, v] of Object.entries(e.line_fees)) expect(byLine[id]?.fee_amount, `${c.id} fee ${id}`).toBe(v);
  if (e.line_gst) for (const [id, v] of Object.entries(e.line_gst)) expect(byLine[id]?.gst_on_net, `${c.id} gst ${id}`).toBe(v);
  if (e.line_totals) for (const [id, v] of Object.entries(e.line_totals)) expect(byLine[id]?.total, `${c.id} total ${id}`).toBe(v);
  if (e.subtotal != null) expect(r.totals.subtotal, `${c.id} subtotal`).toBe(e.subtotal);
  if (e.discount_total != null) expect(r.totals.discount_total, `${c.id} discount_total`).toBe(e.discount_total);
  if (e.fee_total != null) expect(r.totals.fee_total, `${c.id} fee_total`).toBe(e.fee_total);
  if (e.gst_total != null) expect(r.totals.gst_total, `${c.id} gst_total`).toBe(e.gst_total);
  expect(r.totals.total, `${c.id} total`).toBe(e.total);
  if (e.not_applied) for (const id of e.not_applied) expect(totals[id], `${c.id} ${id} must not apply`).toBeUndefined();
  if (e.warnings != null) expect(r.warnings, `${c.id} warnings`).toHaveLength(e.warnings);
  if (e.pricing_status) expect(r.pricing_status).toBe(e.pricing_status);

  // Universal invariants.
  for (const a of r.adjustments) {
    expect(sumCents(a.lines.map((l) => l.amount)), `${c.id} ${key(a)} lines sum`).toBe(a.total);
    const rule = c.rules.find((x) => x.id === a.rule_id);
    if (rule?.cap != null) expect(Math.abs(a.total)).toBeLessThanOrEqual(rule.cap);
  }
  for (const l of r.lines) expect(l.net_amount, `${c.id} ${l.line_id} net >= 0`).toBeGreaterThanOrEqual(0);
  expect(sumCents(r.lines.map((l) => l.total)), `${c.id} line totals sum`).toBe(r.totals.total);
  return r;
}
