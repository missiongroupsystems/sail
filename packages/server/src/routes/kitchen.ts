import type { OpenAPIHono } from "@hono/zod-openapi";
import { registerOperations, type OperationSpec } from "@sail/shared";
import { displayDestinations } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { compact, defineCrud } from "../lib/crud.js";
import { defineOp, errorResponses, jsonBody, jsonResponse, mutationResponse, z, untrusted } from "../lib/openapi.js";
import { outletVisible } from "../auth/principal.js";
import { actOnTicket, allDay, destinationScope, openTickets, orderTickets, type TicketAction } from "../services/kitchen.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent"], emits: [], mcp: { expose: true, toolsets: ["kitchen", "pos.read"] }, ...o });

// Bumping is the kitchen's call: displays and staff only, never agents, and not on MCP.
const act = (action: TicketAction, summary: string, description: string, emits: string): OperationSpec => op({ op: `kitchen_tickets.${action}`, summary, description, tier: "T1", principals: ["station", "staff"], emits: [emits], mcp: { expose: false, toolsets: [] } });

registerOperations({
  "kitchen_tickets.list": op({ op: "kitchen_tickets.list", summary: "Kitchen display tickets of an outlet", description: "Tickets still on the kitchen display (not bumped), oldest fire first, with their lines (voided quantities struck), order, table and the `changed` flag, plus the most recently bumped ticket for Recall. With `order_id`, every ticket of that order in any state (the POS shows a line as ready once its tickets are bumped). A display station sees only its assigned destinations. Never changes anything.", principals: ["staff", "station", "agent"] }),
  "kitchen_tickets.all_day": op({ op: "kitchen_tickets.all_day", summary: "All-day count of items on the kitchen display", description: "For each product, the quantity still to make across the open tickets (not bumped, not cancelled, voids subtracted), largest first." }),
  "kitchen_tickets.start": act("start", "Start a kitchen ticket", "Marks a new or recalled ticket in progress. Tapping it again changes nothing.", "kitchen_ticket.started"),
  "kitchen_tickets.bump": act("bump", "Bump a kitchen ticket (ready)", "Marks the ticket ready and takes it off the display; a cancelled ticket stays cancelled and only leaves the display. A second bump, from this display or another showing the same destination, returns the ticket unchanged.", "kitchen_ticket.bumped"),
  "kitchen_tickets.recall": act("recall", "Recall a bumped kitchen ticket", "Puts a ready ticket back on the display. Recalling a ticket already on the display changes nothing.", "kitchen_ticket.recalled"),
});

const DestinationSchema = z.object({ id: z.string(), outlet_id: z.string(), name: z.string(), include_tags: z.array(z.string()), exclude_tags: z.array(z.string()), order_types: z.array(z.string()), sources: z.array(z.string()), is_default: z.boolean(), archived: z.boolean() });
const DestinationCreate = z.object({
  id: z.uuid().optional(),
  outlet_id: z.uuid(),
  name: z.string().min(1).max(80),
  include_tags: z.array(z.string()).optional(),
  exclude_tags: z.array(z.string()).optional(),
  order_types: z.array(z.enum(["dine_in", "takeaway", "pickup", "delivery"])).optional(),
  sources: z.array(z.enum(["pos", "guest"])).optional(),
  is_default: z.boolean().optional(),
});
const toDestination = (d: typeof displayDestinations.$inferSelect) => ({ id: d.id, outlet_id: d.outletId, name: d.name, include_tags: d.includeTags, exclude_tags: d.excludeTags, order_types: d.orderTypes, sources: d.sources, is_default: d.isDefault, archived: d.archivedAt != null });

const TicketLineSchema = z.object({ id: z.string(), order_line_id: z.string(), product_id: z.string(), name: z.string(), quantity: z.number().int(), voided_quantity: z.number().int(), modifiers: z.array(z.string()), notes: untrusted(z.string().nullable()), seat_no: z.number().int().nullable(), source: z.string() });
const TicketSchema = z.object({
  id: z.string(),
  outlet_id: z.string(),
  destination_id: z.string(),
  destination_name: z.string(),
  order_id: z.string(),
  order_no: z.string(),
  order_type: z.string(),
  table_name: z.string().nullable(),
  customer_name: untrusted(z.string().nullable()),
  pax: z.number().int().nullable(),
  round_no: z.number().int(),
  server_name: z.string().nullable(),
  status: z.enum(["new", "in_progress", "ready", "recalled", "cancelled"]),
  /** A later event (a void) changed the ticket after it reached the display. */
  changed: z.boolean(),
  fired_at: z.string(),
  started_at: z.string().nullable(),
  bumped_at: z.string().nullable(),
  recalled_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  lines: z.array(TicketLineSchema),
});
const ListQuery = z.object({ destination_id: z.uuid().optional(), order_id: z.uuid().optional() });

export function kitchenRoutes(app: OpenAPIHono<AppEnv>) {
  defineCrud(app, {
    group: "display_destinations",
    path: "/v1/display-destinations",
    tag: "kitchen",
    noun: "kitchen display destination",
    table: displayDestinations,
    columns: { id: displayDestinations.id, merchantId: displayDestinations.merchantId, outletId: displayDestinations.outletId, archivedAt: displayDestinations.archivedAt, name: displayDestinations.name },
    api: DestinationSchema,
    create: DestinationCreate,
    patch: DestinationCreate.omit({ id: true, outlet_id: true }).partial(),
    aggregateKind: "display_destination",
    toApi: toDestination,
    fromCreate: (b) => ({ id: b.id, merchantId: "", outletId: b.outlet_id, name: b.name, includeTags: b.include_tags ?? [], excludeTags: b.exclude_tags ?? [], orderTypes: b.order_types ?? [], sources: b.sources ?? [], isDefault: b.is_default ?? false }),
    fromPatch: (b) => compact({ name: b.name, includeTags: b.include_tags, excludeTags: b.exclude_tags, orderTypes: b.order_types, sources: b.sources, isDefault: b.is_default }),
  });

  defineOp(
    app,
    { op: "kitchen_tickets.list", method: "get", path: "/v1/outlets/{id}/kitchen-tickets", tags: ["kitchen"], request: { params: z.object({ id: z.uuid() }), query: ListQuery }, responses: { 200: jsonResponse(z.object({ data: z.array(TicketSchema), next_cursor: z.string().nullable(), last_bumped: TicketSchema.nullable() })), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
      const scope = await destinationScope(p);
      if (q.order_id) return c.json({ data: await orderTickets(id, q.order_id, scope), next_cursor: null, last_bumped: null }, 200);
      const { open, lastBumped } = await openTickets(id, scope, q.destination_id);
      return c.json({ data: open, next_cursor: null, last_bumped: lastBumped }, 200);
    },
  );

  defineOp(
    app,
    { op: "kitchen_tickets.all_day", method: "get", path: "/v1/outlets/{id}/kitchen-tickets/all-day", tags: ["kitchen"], request: { params: z.object({ id: z.uuid() }), query: ListQuery.pick({ destination_id: true }) }, responses: { 200: jsonResponse(z.object({ data: z.array(z.object({ product_id: z.string(), name: z.string(), quantity: z.number().int() })) })), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
      return c.json({ data: await allDay(id, await destinationScope(p), q.destination_id) }, 200);
    },
  );

  for (const action of ["start", "bump", "recall"] as const) {
    defineOp(app, { op: `kitchen_tickets.${action}`, method: "post", path: `/v1/kitchen-tickets/{id}/${action}`, tags: ["kitchen"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(TicketSchema)), ...errorResponses } }, async (c) => {
      const { id } = c.req.valid("param");
      const r = await actOnTicket(action, id, c.get("principal"), { correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") ?? null });
      return c.json({ data: r.ticket, events: r.events, warnings: [] }, 200);
    });
  }
}
