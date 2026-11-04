import { currentTx, isDryRun, tx } from "../db/client.js";
import type { EventActor, EventApproval } from "../db/schema/index.js";
import { actorOf, type Principal } from "../auth/principal.js";
import { businessDateFor } from "./time.js";

export type AppendEventInput = {
  merchantId: string;
  /** Null for merchant-level (configuration) events. */
  outletId: string | null;
  type: string;
  aggregate: { kind: string; id: string; version?: number };
  operationId: string;
  payload?: unknown;
  actor?: EventActor;
  approval?: EventApproval | null;
  reason?: { id?: string; text?: string } | null;
  causationId?: string | null;
  correlationId: string;
  idempotencyKey?: string | null;
  /** Business-day inputs; default Asia/Singapore 04:00 when unknown. */
  businessDay?: { cutoff: string; timeZone: string };
  at?: Date;
};

export type AppendedEvent = { id: string; seq: number; occurredAt: string; type: string; businessDate: string };

/**
 * Append one event in the current transaction, assigning the per-outlet (or
 * per-merchant) sequence under a row lock on the counter. The AFTER INSERT
 * trigger sends pg_notify('sail_events') when the transaction commits.
 */
export async function appendEvent(input: AppendEventInput, principal?: Principal): Promise<AppendedEvent> {
  const sql = tx();
  const at = input.at ?? new Date();
  const bd = input.businessDay ?? { cutoff: "04:00", timeZone: "Asia/Singapore" };
  const businessDate = businessDateFor(at, bd.cutoff, bd.timeZone);
  const actor: EventActor = input.actor ?? (principal ? (actorOf(principal) as EventActor) : { principal_type: "system", principal_id: "system", role: null });
  if (isDryRun()) {
    // Dry runs emit nothing and allocate no sequence (vision 6.2); the caller still sees what WOULD be emitted.
    return { id: "dry-run", seq: -1, occurredAt: at.toISOString(), type: input.type, businessDate };
  }

  // One statement: take the next number from the counter row (locking it until commit) and insert the event.
  // The counter lock is what orders commits per outlet, so callers append events as late as they can.
  const counter = input.outletId
    ? sql`insert into outlet_sequences (outlet_id, merchant_id, next_seq) values (${input.outletId}, ${input.merchantId}, 2)
        on conflict (outlet_id) do update set next_seq = outlet_sequences.next_seq + 1
        returning next_seq - 1 as seq`
    : sql`insert into merchant_sequences (merchant_id, next_seq) values (${input.merchantId}, 2)
        on conflict (merchant_id) do update set next_seq = merchant_sequences.next_seq + 1
        returning next_seq - 1 as seq`;
  const [ev] = await sql<{ id: string; seq: string; occurred_at: string }[]>`
    with s as (${counter})
    insert into events (merchant_id, outlet_id, seq, business_date, occurred_at, type, aggregate_kind, aggregate_id, aggregate_version,
      operation_id, idempotency_key, actor, approval, reason, causation_id, correlation_id, payload)
    select ${input.merchantId}, ${input.outletId}, s.seq, ${businessDate}, ${at.toISOString()}::timestamptz, ${input.type}, ${input.aggregate.kind}, ${input.aggregate.id},
      ${input.aggregate.version ?? 0}, ${input.operationId}, ${input.idempotencyKey ?? null}, ${JSON.stringify(actor)}::jsonb,
      ${input.approval ? JSON.stringify(input.approval) : null}::jsonb, ${input.reason ? JSON.stringify(input.reason) : null}::jsonb,
      ${input.causationId ?? null}, ${input.correlationId}, ${JSON.stringify(input.payload ?? {})}::jsonb
    from s
    returning id, seq, occurred_at`;
  return { id: ev!.id, seq: Number(ev!.seq), occurredAt: new Date(ev!.occurred_at).toISOString(), type: input.type, businessDate };
}

/** Convenience: the current transaction's principal context, if any. */
export function txPrincipal() {
  return currentTx().principal;
}
