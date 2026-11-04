import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { renderPrintJob, type KitchenTicket, type PrintJobPayload, type PrinterProfile, type OrderType } from "@sail/shared";
import { db, isDryRun, tx } from "../db/client.js";
import { brands, merchantSettings, orderLines, orders, outlets, printJobs, printers, stations, tables } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { appendEvent } from "../lib/events.js";
import type { Principal } from "../auth/principal.js";
import { businessDayInputs } from "./business-day.js";

/**
 * Printing (scope doc 4.7): routing rules, server-side rendering with the
 * shared ESC/POS templates, and the durable job queue. One job per target
 * printer (per copy), created in the same transaction as the fire or void.
 */

export type PrinterRow = typeof printers.$inferSelect;
export type JobRow = typeof printJobs.$inferSelect;

export const STALE_CLAIM_SECONDS = 60;
export const LATE_JOB_SECONDS = 10;

export function profileFor(p: PrinterRow): PrinterProfile {
  return { width: p.paperWidth === "58mm" ? "58mm" : "80mm", code_page_cjk: p.codePageCjk, cut: p.cut, beep: p.beep };
}

/** Does a kitchen printer's routing rule match a line fired from `stationId`? */
export function printerMatches(p: PrinterRow, line: { tags: string[]; source: string }, order: { orderType: string }, stationId: string | null): boolean {
  if (p.role !== "kitchen" || p.archivedAt) return false;
  if (p.stationId && p.stationId !== stationId) return false;
  // The default kitchen printer with no include tags is a pure fallback: it takes only items no other printer matched.
  if (p.includeTags.length === 0 && p.isDefaultKitchen) return false;
  if (p.includeTags.length > 0 && !line.tags.some((t) => p.includeTags.includes(t))) return false;
  if (p.excludeTags.length > 0 && line.tags.some((t) => p.excludeTags.includes(t))) return false;
  if (p.orderTypes.length > 0 && !p.orderTypes.includes(order.orderType)) return false;
  if (p.sources.length > 0 && !p.sources.includes(line.source)) return false;
  return true;
}

/** Group lines by target printer following the routing rules; unmatched lines go to the default kitchen printer. */
export function routeLines<L extends { id: string; tags: string[]; source: string }>(all: PrinterRow[], lines: L[], order: { orderType: string }, stationId: string | null): { printer: PrinterRow; lines: L[] }[] {
  const active = all.filter((p) => !p.archivedAt);
  const fallback = active.find((p) => p.isDefaultKitchen && p.role === "kitchen") ?? null;
  const byPrinter = new Map<string, { printer: PrinterRow; lines: L[] }>();
  for (const line of lines) {
    // Outlet printers match by tags; station printers additionally only for their station.
    let targets = active.filter((p) => (p.stationId ? p.stationId === stationId : true) && printerMatches(p, line, order, stationId));
    // A station printer that matched takes the line alongside any outlet printer that matched (bar station prints the drink at the bar too).
    if (targets.length === 0 && fallback) targets = [fallback];
    for (const p of targets) {
      const slot = byPrinter.get(p.id) ?? { printer: p, lines: [] };
      slot.lines.push(line);
      byPrinter.set(p.id, slot);
    }
  }
  return [...byPrinter.values()];
}

async function headerFor(order: typeof orders.$inferSelect, extra: { stationId: string | null; serverName: string | null; jobId: string; round?: number }) {
  const [outlet] = await db().select().from(outlets).where(eq(outlets.id, order.outletId)).limit(1);
  const [brand] = await db().select().from(brands).where(eq(brands.id, order.brandId)).limit(1);
  const [settings] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, order.merchantId)).limit(1);
  const table = order.tableId ? (await db().select({ name: tables.name }).from(tables).where(eq(tables.id, order.tableId)).limit(1))[0] : null;
  const station = extra.stationId ? (await db().select({ name: stations.name }).from(stations).where(eq(stations.id, extra.stationId)).limit(1))[0] : null;
  return {
    outlet_name: outlet?.name ?? "Outlet",
    brand_name: brand?.name ?? "Brand",
    order_no: order.orderNo,
    order_type: order.orderType as OrderType,
    table_name: table?.name,
    pax: order.pax ?? undefined,
    customer_ref: order.customerRef ?? undefined,
    server_name: extra.serverName ?? undefined,
    station_name: station?.name,
    printed_at: new Date().toISOString(),
    job_id: extra.jobId,
    round_no: extra.round,
    ready_by: order.readyBy?.toISOString(),
    delivery_address: order.deliveryAddress ?? undefined,
    delivery_notes: order.deliveryNotes ?? undefined,
    time_zone: settings?.timezone ?? "Asia/Singapore",
    outlet: outlet ?? null,
    settings: settings ?? null,
  };
}

function kitchenLines(lines: (typeof orderLines.$inferSelect)[], quantityOverride?: Map<string, number>): KitchenTicket["lines"] {
  return lines.map((l) => ({
    quantity: quantityOverride?.get(l.id) ?? l.quantity,
    name: l.kitchenName ?? l.name,
    modifiers: l.modifiers.map((m) => (m.quantity > 1 ? `${m.quantity}× ${m.name}` : m.name)),
    notes: l.notes ?? undefined,
    seat_no: l.seatNo ?? undefined,
  }));
}

export type CreatedJob = { id: string; printer_id: string; printer_name: string; kind: string; copy_no: number; copies: number };

/** Insert one rendered job (one copy) and emit `print_job.created`. */
export async function insertJob(input: { merchantId: string; outletId: string; printer: PrinterRow; kind: JobRow["kind"]; payload: PrintJobPayload; orderId?: string | null; checkId?: string | null; refundId?: string | null; copyNo?: number; copies?: number; reprintOf?: string | null; reroutedFrom?: string | null; requestedBy?: string | null; jobId?: string; principal?: Principal; correlationId: string }): Promise<CreatedJob> {
  const id = input.jobId ?? randomUUID();
  // Stamp the job ID into the ticket header before rendering, so it is printed.
  const payload: PrintJobPayload = { ...input.payload, data: { ...input.payload.data, header: { ...input.payload.data.header, job_id: id } } } as PrintJobPayload;
  const rendered = renderPrintJob(payload, profileFor(input.printer));
  const row = {
    id,
    merchantId: input.merchantId,
    outletId: input.outletId,
    printerId: input.printer.id,
    kind: input.kind,
    orderId: input.orderId ?? null,
    checkId: input.checkId ?? null,
    refundId: input.refundId ?? null,
    payload: Buffer.from(rendered.bytes).toString("base64"),
    text: rendered.text,
    document: payload,
    copyNo: input.copyNo ?? 1,
    copies: input.copies ?? 1,
    reprintOf: input.reprintOf ?? null,
    reroutedFrom: input.reroutedFrom ?? null,
    requestedBy: input.requestedBy ?? null,
  } satisfies typeof printJobs.$inferInsert;
  if (!isDryRun()) await db().insert(printJobs).values(row);
  await appendEvent({ merchantId: input.merchantId, outletId: input.outletId, type: "print_job.created", aggregate: { kind: "print_job", id }, operationId: "print_jobs.create", payload: { printer_id: input.printer.id, kind: input.kind, order_id: input.orderId ?? null, copy_no: row.copyNo, copies: row.copies }, correlationId: input.correlationId, businessDay: await businessDayInputs(input.merchantId, input.outletId) }, input.principal);
  return { id, printer_id: input.printer.id, printer_name: input.printer.name, kind: input.kind, copy_no: row.copyNo, copies: row.copies };
}

/** Kitchen tickets for a fire: one job per target printer per copy. Returns created jobs and warnings for unrouted lines. */
export async function createKitchenJobs(input: { order: typeof orders.$inferSelect; lines: (typeof orderLines.$inferSelect)[]; round: number; stationId: string | null; principal: Principal; correlationId: string }): Promise<{ jobs: CreatedJob[]; warnings: string[] }> {
  const all = await db().select().from(printers).where(and(eq(printers.outletId, input.order.outletId), isNull(printers.archivedAt)));
  const routed = routeLines(all, input.lines, input.order, input.stationId);
  const warnings: string[] = [];
  const routedIds = new Set(routed.flatMap((r) => r.lines.map((l) => l.id)));
  const unrouted = input.lines.filter((l) => !routedIds.has(l.id));
  if (unrouted.length) warnings.push(`${unrouted.length} item${unrouted.length === 1 ? "" : "s"} route to no printer and no default kitchen printer is set: ${unrouted.map((l) => l.name).join(", ")}`);
  const jobs: CreatedJob[] = [];
  for (const r of routed) {
    for (let copy = 1; copy <= Math.max(1, r.printer.copies); copy++) {
      const jobId = randomUUID();
      const h = await headerFor(input.order, { stationId: input.stationId, serverName: "name" in input.principal ? input.principal.name : null, jobId, round: input.round });
      const { outlet: _o, settings: _s, ...header } = h;
      const payload: PrintJobPayload = { template: "kitchen_ticket", data: { header, kind: "kitchen", lines: kitchenLines(r.lines), copy_no: copy, copies: r.printer.copies } };
      jobs.push(await insertJob({ merchantId: input.order.merchantId, outletId: input.order.outletId, printer: r.printer, kind: "kitchen", payload, orderId: input.order.id, copyNo: copy, copies: r.printer.copies, jobId, principal: input.principal, correlationId: input.correlationId }));
    }
  }
  return { jobs, warnings };
}

/** Void ticket to every printer that received the item (looked up from its kitchen jobs). */
export async function createVoidJobs(input: { order: typeof orders.$inferSelect; line: typeof orderLines.$inferSelect; quantity: number; principal: Principal; correlationId: string }): Promise<CreatedJob[]> {
  const previous = await db().select().from(printJobs).where(and(eq(printJobs.orderId, input.order.id), eq(printJobs.kind, "kitchen")));
  const printerIds = new Set(previous.filter((j) => (j.document as { data?: { lines?: { name: string }[] } })?.data?.lines?.some((l) => l.name === (input.line.kitchenName ?? input.line.name))).map((j) => j.printerId));
  if (printerIds.size === 0) {
    const all = await db().select().from(printers).where(and(eq(printers.outletId, input.order.outletId), isNull(printers.archivedAt)));
    for (const r of routeLines(all, [input.line], input.order, input.line.firedFromStationId)) printerIds.add(r.printer.id);
  }
  const targets = printerIds.size ? await db().select().from(printers).where(inArray(printers.id, [...printerIds])) : [];
  const jobs: CreatedJob[] = [];
  for (const p of targets) {
    const jobId = randomUUID();
    const h = await headerFor(input.order, { stationId: input.line.firedFromStationId, serverName: "name" in input.principal ? input.principal.name : null, jobId, round: input.line.fireRound ?? undefined });
    const { outlet: _o, settings: _s, ...header } = h;
    const payload: PrintJobPayload = { template: "kitchen_ticket", data: { header, kind: "void", banner: "VOID", lines: kitchenLines([input.line], new Map([[input.line.id, input.quantity]])) } };
    jobs.push(await insertJob({ merchantId: input.order.merchantId, outletId: input.order.outletId, printer: p, kind: "void", payload, orderId: input.order.id, principal: input.principal, correlationId: input.correlationId }));
  }
  return jobs;
}

/** Reprint a job on the same printer (REPRINT banner). */
export async function reprintJob(job: JobRow, principal: Principal, correlationId: string): Promise<CreatedJob> {
  const [printer] = await db().select().from(printers).where(eq(printers.id, job.printerId)).limit(1);
  if (!printer) throw AppError.notFound("printer", job.printerId);
  const doc = job.document as PrintJobPayload;
  const payload: PrintJobPayload = doc.template === "kitchen_ticket" ? { template: "kitchen_ticket", data: { ...doc.data, kind: "reprint", banner: "REPRINT", header: { ...doc.data.header, printed_at: new Date().toISOString() } } } : { ...doc, data: { ...doc.data, header: { ...doc.data.header, printed_at: new Date().toISOString() } } } as PrintJobPayload;
  return insertJob({ merchantId: job.merchantId, outletId: job.outletId, printer, kind: "reprint", payload, orderId: job.orderId, checkId: job.checkId, refundId: job.refundId, reprintOf: job.id, requestedBy: principal.id, principal, correlationId });
}

/** Reroute unprinted jobs to a target printer (default: each job's printer's backup). */
export async function rerouteJobs(jobs: JobRow[], targetPrinterId: string | null, principal: Principal, correlationId: string): Promise<CreatedJob[]> {
  const out: CreatedJob[] = [];
  for (const job of jobs) {
    if (job.status === "printed" || job.status === "rerouted") throw AppError.state(`Job ${job.id} is already ${job.status}`, []);
    const [source] = await db().select().from(printers).where(eq(printers.id, job.printerId)).limit(1);
    const targetId = targetPrinterId ?? source?.backupPrinterId ?? null;
    if (!targetId) throw AppError.invariant("no_backup_printer", `${source?.name ?? "The printer"} has no backup printer`, "Choose a printer to send the tickets to, or set a backup printer in the back office.");
    const [target] = await db().select().from(printers).where(and(eq(printers.id, targetId), isNull(printers.archivedAt))).limit(1);
    if (!target) throw AppError.notFound("printer", targetId);
    if (source && target.role !== source.role) throw AppError.invariant("printer_role_mismatch", `${target.name} is a ${target.role} printer`, "Choose a printer with the same role.");
    const doc = job.document as PrintJobPayload;
    const payload: PrintJobPayload = { ...doc, data: { ...doc.data, header: { ...doc.data.header, printed_at: new Date().toISOString() } } } as PrintJobPayload;
    const created = await insertJob({ merchantId: job.merchantId, outletId: job.outletId, printer: target, kind: job.kind, payload, orderId: job.orderId, checkId: job.checkId, refundId: job.refundId, copyNo: job.copyNo, copies: job.copies, reroutedFrom: job.id, requestedBy: principal.id, principal, correlationId });
    await db().update(printJobs).set({ status: "rerouted", reroutedTo: created.id }).where(eq(printJobs.id, job.id));
    out.push(created);
  }
  return out;
}

export async function testJob(printer: PrinterRow, principal: Principal, correlationId: string): Promise<CreatedJob> {
  const [outlet] = await db().select().from(outlets).where(eq(outlets.id, printer.outletId)).limit(1);
  const payload: PrintJobPayload = {
    template: "kitchen_ticket",
    data: {
      header: { outlet_name: outlet?.name ?? "Outlet", brand_name: "Sail", order_no: "TEST", order_type: "dine_in", printed_at: new Date().toISOString(), job_id: "pending", station_name: printer.name, server_name: "name" in principal ? principal.name : undefined },
      kind: "kitchen",
      banner: "TEST PRINT",
      lines: [{ quantity: 1, name: `Test print on ${printer.name}`, modifiers: [`${printer.ip}:${printer.port}`, `${printer.paperWidth} paper`], notes: "If you can read this, the relay and printer are working." }],
    },
  };
  return insertJob({ merchantId: printer.merchantId, outletId: printer.outletId, printer, kind: "test", payload, requestedBy: principal.id, principal, correlationId });
}

/** Worker: re-queue claims that went stale (relay died mid-job). Returns the re-queued job IDs. */
export async function requeueStaleClaims(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_SECONDS * 1000);
  const rows = await db()
    .update(printJobs)
    .set({ status: "queued", claimedBy: null, claimedAt: null, lastError: "claim went stale; re-queued" })
    .where(and(eq(printJobs.status, "claimed"), lt(printJobs.claimedAt, cutoff)))
    .returning({ id: printJobs.id });
  return rows.map((r) => r.id);
}

/** Jobs not printed within LATE_JOB_SECONDS, for the POS alert. */
export async function lateJobs(outletId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - LATE_JOB_SECONDS * 1000);
  return db()
    .select()
    .from(printJobs)
    .where(and(eq(printJobs.outletId, outletId), sql`${printJobs.status} in ('queued','claimed','failed')`, lt(printJobs.createdAt, cutoff)));
}

export { tx };
