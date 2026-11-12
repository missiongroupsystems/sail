import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { registerOperations } from "@sail/shared";
import { db, withTransaction, type RequestTx } from "../db/client.js";
import { auditLog, printJobs, printRelays, printers, relayPairingCodes } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z, untrusted } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { compact, defineCrud } from "../lib/crud.js";
import { outletVisible, type Principal } from "../auth/principal.js";
import { hashSecret, randomDigits, sha256, signSailToken, verifySailToken, verifySecret } from "../auth/tokens.js";
import { registerRelayResolver } from "../auth/resolve.js";
import { applyRls } from "../middleware/pipeline.js";
import { serveStream } from "../sse/stream.js";
import { lateJobs, reprintJob, rerouteJobs, testJob } from "../services/printing.js";
import { businessDayInputs } from "./org.js";

registerOperations({
  "relays.pairing_code": { op: "relays.pairing_code", summary: "Issue a one-time pairing code for a print relay", description: "Admin only; expires in 15 minutes. The relay device exchanges it for a relay token with relays.pair.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["relay.pairing_code_issued"], mcp: { expose: false, toolsets: [] } },
  "relays.pair": { op: "relays.pair", summary: "Pair a print relay", description: "Exchanges a pairing code for a relay token. No authentication; single-use code. Pairing a spare replaces the previous token.", tier: "T3", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: [], emits: ["relay.paired"], mcp: { expose: false, toolsets: [] } },
  "relays.heartbeat": { op: "relays.heartbeat", summary: "Relay heartbeat", description: "Every 30 s: version and printer reachability. Relay principal only.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["relay"], emits: [], mcp: { expose: false, toolsets: [] } },
  "relays.printers": { op: "relays.printers", summary: "Printers for a relay's outlet", description: "Relay principal only.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["relay"], emits: [], mcp: { expose: false, toolsets: [] } },
  "relays.jobs": { op: "relays.jobs", summary: "Outstanding print jobs for a relay", description: "Queued (and the relay's own claimed) jobs with their ESC/POS payloads. The relay calls this on connect and after every reconnect (catch-up).", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["relay"], emits: [], mcp: { expose: false, toolsets: [] } },
  "relays.stream": { op: "relays.stream", summary: "Relay live-update stream (SSE)", description: "Signals new or changed print jobs for the relay's outlet. Catch up with relays.jobs on connect and on `resync`.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["relay"], emits: [], mcp: { expose: false, toolsets: [] } },
  "print_jobs.claim": { op: "print_jobs.claim", summary: "Claim a queued job", description: "Relay principal only. Moves queued → claimed; another relay claiming the same job gets state_conflict.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["relay"], emits: ["print_job.claimed"], mcp: { expose: false, toolsets: [] } },
  "print_jobs.ack": { op: "print_jobs.ack", summary: "Acknowledge a job result", description: "Relay principal only. claimed → printed, or → failed with the error. Retries reuse the job ID.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["relay"], emits: ["print_job.printed", "print_job.failed"], mcp: { expose: false, toolsets: [] } },
  "print_jobs.list": { op: "print_jobs.list", summary: "Print jobs of an outlet", description: "By status, printer or order; `late=true` returns jobs not printed within 10 seconds (the POS alert). Includes the plain-text rendering for previews.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent"], emits: [], mcp: { expose: true, toolsets: ["kitchen", "watch", "reports"] } },
  "print_jobs.reprint": { op: "print_jobs.reprint", summary: "Reprint a ticket", description: "A new job marked REPRINT on the same printer.", tier: "T1", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: ["print_job.created"], mcp: { expose: true, toolsets: ["kitchen"] } },
  "print_jobs.reroute": { op: "print_jobs.reroute", summary: "Reroute waiting tickets to another printer", description: "New jobs on the target printer (default: each printer's configured backup); the originals are marked rerouted. Not for jobs already printed.", tier: "T1", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: ["print_job.created", "print_job.rerouted"], mcp: { expose: true, toolsets: ["kitchen"] } },
  "print_jobs.test": { op: "print_jobs.test", summary: "Test print", description: "Sends a test ticket to a printer. Admin.", tier: "T1", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["print_job.created"], mcp: { expose: false, toolsets: [] } },
});

/* ---- Relay principal ---------------------------------------------------- */

registerRelayResolver(async (token: string, t: RequestTx) => {
  const claims = await verifySailToken(token, "relay");
  const [relay] = await t.db.select().from(printRelays).where(eq(printRelays.id, claims.relay_id!)).limit(1);
  if (!relay || relay.archivedAt || !relay.tokenHash || relay.tokenHash !== sha256(token)) throw new AppError("unauthenticated", "This relay is no longer paired", { remedy: "Pair the relay again with a new code." });
  return { type: "relay", id: relay.id, merchantId: relay.merchantId, outletId: relay.outletId, relayId: relay.id };
});

/* ---- Schemas ----------------------------------------------------------- */

const PrinterSchema = z.object({
  id: z.string(),
  outlet_id: z.string(),
  name: z.string(),
  ip: z.string(),
  port: z.number().int(),
  paper_width: z.enum(["80mm", "58mm"]),
  role: z.enum(["kitchen", "receipt"]),
  station_id: z.string().nullable(),
  include_tags: z.array(z.string()),
  exclude_tags: z.array(z.string()),
  order_types: z.array(z.string()),
  sources: z.array(z.string()),
  copies: z.number().int(),
  backup_printer_id: z.string().nullable(),
  is_default_kitchen: z.boolean(),
  supports_status: z.boolean(),
  code_page_cjk: z.boolean(),
  cut: z.boolean(),
  beep: z.boolean(),
  archived: z.boolean(),
});
const PrinterCreate = z.object({
  id: z.uuid().optional(),
  outlet_id: z.uuid(),
  name: z.string().min(1),
  ip: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9.-]+$/i),
  port: z.number().int().min(1).max(65535).optional(),
  paper_width: z.enum(["80mm", "58mm"]).optional(),
  role: z.enum(["kitchen", "receipt"]).optional(),
  station_id: z.uuid().nullable().optional(),
  include_tags: z.array(z.string()).optional(),
  exclude_tags: z.array(z.string()).optional(),
  order_types: z.array(z.enum(["dine_in", "takeaway", "pickup", "delivery"])).optional(),
  sources: z.array(z.enum(["pos", "guest"])).optional(),
  copies: z.number().int().min(1).max(5).optional(),
  backup_printer_id: z.uuid().nullable().optional(),
  is_default_kitchen: z.boolean().optional(),
  supports_status: z.boolean().optional(),
  code_page_cjk: z.boolean().optional(),
  cut: z.boolean().optional(),
  beep: z.boolean().optional(),
});
export const toPrinter = (p: typeof printers.$inferSelect) => ({ id: p.id, outlet_id: p.outletId, name: p.name, ip: p.ip, port: p.port, paper_width: p.paperWidth as "80mm" | "58mm", role: p.role, station_id: p.stationId, include_tags: p.includeTags, exclude_tags: p.excludeTags, order_types: p.orderTypes, sources: p.sources, copies: p.copies, backup_printer_id: p.backupPrinterId, is_default_kitchen: p.isDefaultKitchen, supports_status: p.supportsStatus, code_page_cjk: p.codePageCjk, cut: p.cut, beep: p.beep, archived: p.archivedAt != null });

const RelaySchema = z.object({ id: z.string(), outlet_id: z.string(), name: z.string(), paired: z.boolean(), paired_at: z.string().nullable(), last_seen_at: z.string().nullable(), online: z.boolean(), version: z.string().nullable(), printer_status: z.record(z.string(), z.object({ ok: z.boolean(), checked_at: z.string(), error: z.string().optional() })), archived: z.boolean() });
const toRelay = (r: typeof printRelays.$inferSelect) => ({ id: r.id, outlet_id: r.outletId, name: r.name, paired: r.tokenHash != null, paired_at: r.pairedAt?.toISOString() ?? null, last_seen_at: r.lastSeenAt?.toISOString() ?? null, online: !!r.lastSeenAt && Date.now() - r.lastSeenAt.getTime() < 90_000, version: r.version, printer_status: r.printerStatus, archived: r.archivedAt != null });

const JobSchema = z.object({
  id: z.string(),
  outlet_id: z.string(),
  printer_id: z.string(),
  kind: z.string(),
  order_id: z.string().nullable(),
  check_id: z.string().nullable(),
  status: z.string(),
  attempts: z.number().int(),
  copy_no: z.number().int(),
  copies: z.number().int(),
  claimed_by: z.string().nullable(),
  claimed_at: z.string().nullable(),
  printed_at: z.string().nullable(),
  last_error: z.string().nullable(),
  reprint_of: z.string().nullable(),
  rerouted_to: z.string().nullable(),
  rerouted_from: z.string().nullable(),
  created_at: z.string(),
  age_seconds: z.number().int(),
  /** The fire round the ticket belongs to (kitchen, void and reprint tickets), so clients match tickets to rounds without guessing from timestamps. */
  round_no: z.number().int().nullable(),
  /** The rendered ticket, with the guests' and staff's notes on it. */
  text: untrusted(z.string()),
  /** Base64 ESC/POS bytes; only returned to relays. */
  payload: z.string().optional(),
});
const toJob = (j: typeof printJobs.$inferSelect, withPayload = false) => ({
  id: j.id,
  outlet_id: j.outletId,
  printer_id: j.printerId,
  kind: j.kind,
  order_id: j.orderId,
  check_id: j.checkId,
  status: j.status,
  attempts: j.attempts,
  copy_no: j.copyNo,
  copies: j.copies,
  claimed_by: j.claimedBy,
  claimed_at: j.claimedAt?.toISOString() ?? null,
  printed_at: j.printedAt?.toISOString() ?? null,
  last_error: j.lastError,
  reprint_of: j.reprintOf,
  rerouted_to: j.reroutedTo,
  rerouted_from: j.reroutedFrom,
  created_at: j.createdAt.toISOString(),
  age_seconds: Math.max(0, Math.floor((Date.now() - j.createdAt.getTime()) / 1000)),
  round_no: (j.document as { data?: { header?: { round_no?: number } } } | null)?.data?.header?.round_no ?? null,
  text: j.text,
  ...(withPayload ? { payload: j.payload } : {}),
});

const CreatedJobsSchema = z.array(z.object({ id: z.string(), printer_id: z.string(), printer_name: z.string(), kind: z.string(), copy_no: z.number().int(), copies: z.number().int() }));

export function printingRoutes(app: OpenAPIHono<AppEnv>) {
  defineCrud(app, {
    group: "printers",
    path: "/v1/printers",
    tag: "printing",
    noun: "printer",
    table: printers,
    columns: { id: printers.id, merchantId: printers.merchantId, outletId: printers.outletId, archivedAt: printers.archivedAt, name: printers.name },
    api: PrinterSchema,
    create: PrinterCreate,
    patch: PrinterCreate.omit({ id: true, outlet_id: true }).partial(),
    aggregateKind: "printer",
    principals: { read: ["staff", "station", "agent", "relay"] },
    toApi: toPrinter,
    fromCreate: (b) => ({ id: b.id, merchantId: "", outletId: b.outlet_id, name: b.name, ip: b.ip, port: b.port ?? 9100, paperWidth: b.paper_width ?? "80mm", role: b.role ?? "kitchen", stationId: b.station_id ?? null, includeTags: b.include_tags ?? [], excludeTags: b.exclude_tags ?? [], orderTypes: b.order_types ?? [], sources: b.sources ?? [], copies: b.copies ?? 1, backupPrinterId: b.backup_printer_id ?? null, isDefaultKitchen: b.is_default_kitchen ?? false, supportsStatus: b.supports_status ?? true, codePageCjk: b.code_page_cjk ?? false, cut: b.cut ?? true, beep: b.beep ?? false }),
    fromPatch: (b) => compact({ name: b.name, ip: b.ip, port: b.port, paperWidth: b.paper_width, role: b.role, stationId: b.station_id, includeTags: b.include_tags, excludeTags: b.exclude_tags, orderTypes: b.order_types, sources: b.sources, copies: b.copies, backupPrinterId: b.backup_printer_id, isDefaultKitchen: b.is_default_kitchen, supportsStatus: b.supports_status, codePageCjk: b.code_page_cjk, cut: b.cut, beep: b.beep }),
  });

  defineCrud(app, {
    group: "relays",
    path: "/v1/relays",
    tag: "printing",
    noun: "print relay",
    table: printRelays,
    columns: { id: printRelays.id, merchantId: printRelays.merchantId, outletId: printRelays.outletId, archivedAt: printRelays.archivedAt, name: printRelays.name },
    api: RelaySchema,
    create: z.object({ id: z.uuid().optional(), outlet_id: z.uuid(), name: z.string().min(1) }),
    patch: z.object({ name: z.string().min(1).optional() }),
    aggregateKind: "relay",
    mcp: { read: false },
    toApi: toRelay,
    fromCreate: (b) => ({ id: b.id, merchantId: "", outletId: b.outlet_id, name: b.name }),
    fromPatch: (b) => compact({ name: b.name }),
  });

  defineOp(app, { op: "relays.pairing_code", method: "post", path: "/v1/relays/{id}/pairing-code", tags: ["printing"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(z.object({ code: z.string(), expires_at: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [relay] = await db().select().from(printRelays).where(and(eq(printRelays.id, id), isNull(printRelays.archivedAt))).limit(1);
    if (!relay) throw AppError.notFound("relay", id);
    const code = randomDigits(6);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await db().insert(relayPairingCodes).values({ merchantId: p.merchantId, relayId: id, codeHash: hashSecret(code), expiresAt });
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: relay.outletId, type: "relay.pairing_code_issued", aggregate: { kind: "relay", id }, operationId: "relays.pairing_code", payload: { expires_at: expiresAt.toISOString() }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, relay.outletId) }, p);
    await recordAudit(p, { action: "relays.pairing_code", targetKind: "relay", targetId: id, outletId: relay.outletId });
    return c.json({ data: { code, expires_at: expiresAt.toISOString() }, events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "relays.pair", method: "post", path: "/v1/relays/pair", tags: ["printing"], request: { body: jsonBody(z.object({ code: z.string().regex(/^\d{6}$/), version: z.string().max(40).optional() })) }, responses: { 200: jsonResponse(dataResponse(z.object({ relay_token: z.string(), relay: RelaySchema }))), ...errorResponses } }, async (c) => {
    const { code, version } = c.req.valid("json");
    const result = await withTransaction(async (t) => {
      const candidates = await t.db.select().from(relayPairingCodes).where(and(isNull(relayPairingCodes.usedAt), gt(relayPairingCodes.expiresAt, new Date())));
      const match = candidates.find((x) => verifySecret(code, x.codeHash));
      if (!match) throw new AppError("unauthenticated", "Pairing code not recognised or expired", { remedy: "Ask an Admin for a new code from the relay's page in the back office." });
      const token = await signSailToken({ typ: "relay", merchant_id: match.merchantId, relay_id: match.relayId }, null);
      await t.db.update(relayPairingCodes).set({ usedAt: new Date() }).where(eq(relayPairingCodes.id, match.id));
      const [relay] = await t.db.update(printRelays).set({ tokenHash: sha256(token), pairedAt: new Date(), lastSeenAt: new Date(), version: version ?? null }).where(eq(printRelays.id, match.relayId)).returning();
      await appendEvent({ merchantId: relay!.merchantId, outletId: relay!.outletId, type: "relay.paired", aggregate: { kind: "relay", id: relay!.id }, operationId: "relays.pair", payload: { version: version ?? null }, actor: { principal_type: "relay", principal_id: relay!.id, role: null }, correlationId: c.get("correlationId") });
      await t.db.insert(auditLog).values({ merchantId: relay!.merchantId, outletId: relay!.outletId, actorType: "relay", actorId: relay!.id, action: "relays.pair", targetKind: "relay", targetId: relay!.id, details: { version: version ?? null } });
      return { token, relay: relay! };
    });
    return c.json({ data: { relay_token: result.token, relay: toRelay(result.relay) } }, 200);
  });

  const relayOnly = (p: Principal, id: string) => {
    if (p.type !== "relay" || p.relayId !== id) throw AppError.notFound("relay", id);
    return p;
  };

  defineOp(app, { op: "relays.heartbeat", method: "post", path: "/v1/relays/{id}/heartbeat", tags: ["printing"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ version: z.string().max(40).optional(), printer_status: z.record(z.string(), z.object({ ok: z.boolean(), checked_at: z.string(), error: z.string().optional() })).optional() })) }, responses: { 200: jsonResponse(dataResponse(z.object({ ok: z.boolean(), server_time: z.string() }))), ...errorResponses } }, async (c) => {
    const p = relayOnly(c.get("principal"), c.req.valid("param").id);
    const b = c.req.valid("json");
    await db().update(printRelays).set({ lastSeenAt: new Date(), ...compact({ version: b.version, printerStatus: b.printer_status }) }).where(eq(printRelays.id, p.relayId));
    return c.json({ data: { ok: true, server_time: new Date().toISOString() } }, 200);
  });

  defineOp(app, { op: "relays.printers", method: "get", path: "/v1/relays/{id}/printers", tags: ["printing"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(listResponse(PrinterSchema)), ...errorResponses } }, async (c) => {
    const p = relayOnly(c.get("principal"), c.req.valid("param").id);
    const rows = await db().select().from(printers).where(and(eq(printers.outletId, p.outletId), isNull(printers.archivedAt))).orderBy(asc(printers.name));
    return c.json({ data: rows.map(toPrinter), next_cursor: null }, 200);
  });

  defineOp(app, { op: "relays.jobs", method: "get", path: "/v1/relays/{id}/jobs", tags: ["printing"], request: { params: z.object({ id: z.uuid() }), query: z.object({ status: z.enum(["queued", "claimed"]).optional() }) }, responses: { 200: jsonResponse(listResponse(JobSchema)), ...errorResponses } }, async (c) => {
    const p = relayOnly(c.get("principal"), c.req.valid("param").id);
    const q = c.req.valid("query");
    const conds: SQL[] = [eq(printJobs.outletId, p.outletId)];
    if (q.status === "claimed") conds.push(and(eq(printJobs.status, "claimed"), eq(printJobs.claimedBy, p.relayId))!);
    else if (q.status === "queued") conds.push(eq(printJobs.status, "queued"));
    else conds.push(sql`(${printJobs.status} = 'queued' or (${printJobs.status} = 'claimed' and ${printJobs.claimedBy} = ${p.relayId}))`);
    const rows = await db()
      .select()
      .from(printJobs)
      .where(and(...conds))
      .orderBy(asc(printJobs.createdAt))
      .limit(200);
    return c.json({ data: rows.map((j) => toJob(j, true)), next_cursor: null }, 200);
  });

  defineOp(app, { op: "relays.stream", method: "get", path: "/v1/relays/{id}/stream", tags: ["printing"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: { description: "text/event-stream: hello, job, resync", content: { "text/event-stream": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = relayOnly(c.get("principal"), c.req.valid("param").id);
    const pending = await withTransaction(async (t) => {
      await applyRls(t, p);
      const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(printJobs).where(and(eq(printJobs.outletId, p.outletId), eq(printJobs.status, "queued")));
      await t.db.update(printRelays).set({ lastSeenAt: new Date() }).where(eq(printRelays.id, p.relayId));
      return row?.n ?? 0;
    });
    return serveStream(c, [`relay:${p.outletId}`], { outlet_id: p.outletId, queued: pending, relay_id: p.relayId }, (n) => n.kind !== "event");
  });

  defineOp(app, { op: "print_jobs.claim", method: "post", path: "/v1/relays/{id}/jobs/{job_id}/claim", tags: ["printing"], request: { params: z.object({ id: z.uuid(), job_id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(dataResponse(JobSchema)), ...errorResponses } }, async (c) => {
    const p = relayOnly(c.get("principal"), c.req.valid("param").id);
    const { job_id } = c.req.valid("param");
    const [row] = await db()
      .update(printJobs)
      .set({ status: "claimed", claimedBy: p.relayId, claimedAt: new Date(), attempts: sql`${printJobs.attempts} + 1` })
      .where(and(eq(printJobs.id, job_id), eq(printJobs.outletId, p.outletId), eq(printJobs.status, "queued")))
      .returning();
    if (!row) {
      const [existing] = await db().select().from(printJobs).where(eq(printJobs.id, job_id)).limit(1);
      if (!existing) throw AppError.notFound("print job", job_id);
      if (existing.status === "claimed" && existing.claimedBy === p.relayId) return c.json({ data: toJob(existing, true) }, 200); // idempotent re-claim by the same relay
      throw AppError.state(`Job is ${existing.status}`, ["queued → claimed"], "Another relay has this job, or it is already done.");
    }
    await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: "print_job.claimed", aggregate: { kind: "print_job", id: job_id }, operationId: "print_jobs.claim", payload: { relay_id: p.relayId, attempt: row.attempts }, correlationId: c.get("correlationId"), businessDay: await businessDayInputs(p.merchantId, p.outletId) }, p);
    return c.json({ data: toJob(row, true) }, 200);
  });

  defineOp(app, { op: "print_jobs.ack", method: "post", path: "/v1/relays/{id}/jobs/{job_id}/ack", tags: ["printing"], request: { params: z.object({ id: z.uuid(), job_id: z.uuid() }), body: jsonBody(z.object({ ok: z.boolean(), error: z.string().max(300).optional(), requeue: z.boolean().optional() })) }, responses: { 200: jsonResponse(dataResponse(JobSchema)), ...errorResponses } }, async (c) => {
    const p = relayOnly(c.get("principal"), c.req.valid("param").id);
    const { job_id } = c.req.valid("param");
    const b = c.req.valid("json");
    const [job] = await db().select().from(printJobs).where(and(eq(printJobs.id, job_id), eq(printJobs.outletId, p.outletId))).limit(1);
    if (!job) throw AppError.notFound("print job", job_id);
    if (job.status !== "claimed" || job.claimedBy !== p.relayId) throw AppError.state(`Job is ${job.status}`, ["claimed → printed", "claimed → failed"]);
    const status = b.ok ? "printed" : b.requeue ? "queued" : "failed";
    const [row] = await db()
      .update(printJobs)
      .set({ status, printedAt: b.ok ? new Date() : null, failedAt: status === "failed" ? new Date() : null, lastError: b.ok ? null : (b.error ?? "unknown error"), claimedBy: status === "queued" ? null : job.claimedBy, claimedAt: status === "queued" ? null : job.claimedAt })
      .where(eq(printJobs.id, job_id))
      .returning();
    await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: b.ok ? "print_job.printed" : status === "queued" ? "print_job.requeued" : "print_job.failed", aggregate: { kind: "print_job", id: job_id }, operationId: "print_jobs.ack", payload: { relay_id: p.relayId, error: b.error ?? null, order_id: job.orderId, printer_id: job.printerId, attempts: job.attempts }, correlationId: c.get("correlationId"), businessDay: await businessDayInputs(p.merchantId, p.outletId) }, p);
    return c.json({ data: toJob(row!) }, 200);
  });

  defineOp(app, { op: "print_jobs.list", method: "get", path: "/v1/outlets/{id}/print-jobs", tags: ["printing"], request: { params: z.object({ id: z.uuid() }), query: z.object({ status: z.string().optional(), printer_id: z.uuid().optional(), order_id: z.uuid().optional(), late: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }, responses: { 200: jsonResponse(listResponse(JobSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
    if (q.late === "true") return c.json({ data: (await lateJobs(id)).map((j) => toJob(j)), next_cursor: null }, 200);
    const conds: SQL[] = [eq(printJobs.outletId, id)];
    if (q.status) conds.push(inArray(printJobs.status, q.status.split(",") as JobRowStatus[]));
    if (q.printer_id) conds.push(eq(printJobs.printerId, q.printer_id));
    if (q.order_id) conds.push(eq(printJobs.orderId, q.order_id));
    const rows = await db()
      .select()
      .from(printJobs)
      .where(and(...conds))
      .orderBy(desc(printJobs.createdAt))
      .limit(q.limit);
    return c.json({ data: rows.map((j) => toJob(j)), next_cursor: null }, 200);
  });

  defineOp(app, { op: "print_jobs.reprint", method: "post", path: "/v1/print-jobs/{id}/reprint", tags: ["printing"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(CreatedJobsSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [job] = await db().select().from(printJobs).where(eq(printJobs.id, id)).limit(1);
    if (!job) throw AppError.notFound("print job", id);
    const created = await reprintJob(job, p, c.get("correlationId"));
    await recordAudit(p, { action: "print_jobs.reprint", targetKind: "print_job", targetId: id, outletId: job.outletId, details: { new_job_id: created.id } });
    return c.json({ data: [created], events: [], warnings: [] }, 201);
  });

  defineOp(app, { op: "print_jobs.reroute", method: "post", path: "/v1/print-jobs/reroute", tags: ["printing"], request: { body: jsonBody(z.object({ job_ids: z.array(z.uuid()).min(1).max(100), printer_id: z.uuid().nullable().optional() })) }, responses: { 201: jsonResponse(mutationResponse(CreatedJobsSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    const jobs = await db().select().from(printJobs).where(inArray(printJobs.id, b.job_ids));
    if (jobs.length !== b.job_ids.length) throw AppError.notFound("print job");
    const created = await rerouteJobs(jobs, b.printer_id ?? null, p, c.get("correlationId"));
    for (const j of jobs) await appendEvent({ merchantId: p.merchantId, outletId: j.outletId, type: "print_job.rerouted", aggregate: { kind: "print_job", id: j.id }, operationId: "print_jobs.reroute", payload: { to: created.find((x) => true)?.printer_id ?? null }, correlationId: c.get("correlationId"), businessDay: await businessDayInputs(p.merchantId, j.outletId) }, p);
    await recordAudit(p, { action: "print_jobs.reroute", targetKind: "print_job", targetId: b.job_ids.join(","), outletId: jobs[0]?.outletId ?? null, details: { count: created.length, printer_id: b.printer_id ?? "backup" } });
    return c.json({ data: created, events: [], warnings: [] }, 201);
  });

  defineOp(app, { op: "print_jobs.test", method: "post", path: "/v1/printers/{id}/test", tags: ["printing"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(CreatedJobsSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [printer] = await db().select().from(printers).where(and(eq(printers.id, id), isNull(printers.archivedAt))).limit(1);
    if (!printer) throw AppError.notFound("printer", id);
    const created = await testJob(printer, p, c.get("correlationId"));
    await recordAudit(p, { action: "print_jobs.test", targetKind: "printer", targetId: id, outletId: printer.outletId });
    return c.json({ data: [created], events: [], warnings: [] }, 201);
  });
}

type JobRowStatus = typeof printJobs.$inferSelect.status;
