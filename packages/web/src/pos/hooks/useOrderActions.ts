"use client";

import { useQueryClient } from "@tanstack/react-query";
import { formatBpsText, useLocale } from "@sail/ui";
import { useCallback, useMemo } from "react";
import { ApiError, idempotencyKey, toApiError } from "@/lib/api";
import { OP_MIN_ROLE } from "@/lib/op-roles";
import * as reg from "../api/register";
import { reportUnreachable } from "../events/stream";
import type { CheckPayment, CheckSnapshot, CompiledProduct, ManualRule, MutationResult, OrderSnapshot, OrderType, OverrideAction, OverrideSubject, PaymentIntent, PaymentResult, ReceiptChannel, RefundRequest, RefundResult, Role, SnapshotLine } from "../api/types";
import { useSessionStore } from "../state/session";
import { useConnectionStore, useUiStore } from "../state/ui";
import { applySnapshot, holdPendingLine, posKeys, releasePendingLine } from "./queries";
import { useApi } from "./useApi";

/** The Send on the wire for each order, shared by every screen that offers Send. */
const sending = new Map<string, Promise<OrderSnapshot | null>>();
/**
 * The last write this station queued on each order. Writes to one order go one after another, each with the version
 * the one before it left, so fast taps never race each other into a 409 (the register would refuse every add sent
 * with a version an earlier add had already moved on).
 */
const writes = new Map<string, Promise<unknown>>();

function inTurn<T>(orderId: string, write: () => Promise<T>): Promise<T> {
  const previous = writes.get(orderId) ?? Promise.resolve();
  const result = previous.then(write);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  writes.set(orderId, settled);
  void settled.then(() => {
    if (writes.get(orderId) === settled) writes.delete(orderId);
  });
  return result;
}

const RANK: Record<Role, number> = { server: 10, cashier: 20, manager: 30, finance: 40, admin: 50 };
const MIN_ROLE: Record<OverrideAction, Role> = { "lines.void_fired": "manager", "lines.add_open_price": "manager", "adjustments.apply_manual": "server", "adjustments.remove": "server", "payments.record": "cashier", "refunds.create": "manager", "orders.reopen": "manager", "payments.void": "manager" };

/** Adds to an order that wait for the add before them and then go to the register in one request. */
type AddBatchResult = { snap: OrderSnapshot | null; refused: Map<string, unknown> };
type AddBatch = { bodies: reg.LineInput[]; names: string[]; key: string; open: boolean; maybeLanded: boolean; reported: Set<string>; done: Promise<AddBatchResult> };
/** The batch of each order still taking taps: it closes when its request goes. */
const addBatches = new Map<string, AddBatch>();

export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  return role ? RANK[role] >= RANK[min] : false;
}

/** The call never reached the register (no network, or no reply in time), as opposed to the register saying no. */
const unreachable = (e: unknown) => e instanceof ApiError && e.status === 0 && e.code === "unavailable";

/** Resolves once the station hears from the register again. */
function whenOnline(): Promise<void> {
  return new Promise((resolve) => {
    if (useConnectionStore.getState().status === "online") return resolve();
    const stop = useConnectionStore.subscribe((s) => {
      if (s.status !== "online") return;
      stop();
      resolve();
    });
  });
}

export type AddLineInput = {
  product: CompiledProduct;
  quantity: number;
  modifiers?: { group_id: string; product_id: string; name: string; price: number; quantity?: number }[];
  notes?: string | null;
  seat?: number | null;
  hold?: boolean;
  openPrice?: number | null;
  orderType: OrderType;
};

/**
 * Every change to one order, with the register's rules applied on the client
 * side of the contract: optimistic lines that never show a guessed amount,
 * `expected_version` on edits with a quiet retry for new lines, Undo for T1
 * actions, and the manager approval sheet for T3 actions.
 */
export function useOrderActions(orderId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const role = useSessionStore((s) => s.staff?.role ?? null);
  const mayReadInvoice = roleAtLeast(role, OP_MIN_ROLE["documents.invoice_pdf"] ?? "server");
  const { money } = useLocale();
  const { notify, showUndo, beginMutation, endMutation, requestOverride } = useUiStore.getState();

  const key = useMemo(() => posKeys.order(orderId), [orderId]);
  const snapshot = useCallback(() => qc.getQueryData<OrderSnapshot>(key), [qc, key]);

  const fail = useCallback(
    (e: unknown) => {
      const err = toApiError(e);
      if (unreachable(e)) reportUnreachable();
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert", orderId }, 8000);
    },
    [notify, orderId],
  );

  /**
   * Run a register mutation with `expected_version`, keep the snapshot it
   * returns, and handle a version conflict: refetch, then either retry once
   * without a version (safe for adding lines) or tell the user in one line.
   * It waits for this station's earlier writes to the order (see `inTurn`), and
   * reads the version only then, so a conflict is always another station's.
   */
  const run = useCallback(
    async (exec: (expectedVersion: number | null) => Promise<MutationResult>, opts: { versioned?: boolean; onConflict?: "retry-unversioned" | "refetch"; onRetried?: () => void } = {}): Promise<OrderSnapshot | null> => {
      beginMutation(orderId);
      try {
        return await inTurn(orderId, async () => {
          const current = snapshot();
          const expected = opts.versioned === false ? null : (current?.version ?? null);
          try {
            const res = await exec(expected);
            applySnapshot(qc, res.data);
            for (const w of res.warnings) notify({ text: w, tone: "info", orderId }, 6000);
            return res.data;
          } catch (e) {
            if (e instanceof ApiError && e.code === "version_conflict") {
              await qc.invalidateQueries({ queryKey: key });
              if (opts.onConflict === "retry-unversioned") {
                const res = await exec(null);
                applySnapshot(qc, res.data);
                opts.onRetried?.();
                return res.data;
              }
              notify({ text: "The order changed on another station", remedy: "Check the order and try again.", tone: "info", orderId }, 6000);
              return null;
            }
            throw e;
          }
        });
      } finally {
        endMutation(orderId);
      }
    },
    [beginMutation, endMutation, key, notify, orderId, qc, snapshot],
  );

  /**
   * Manager approval: if the role is below the action's minimum,
   * ask first; if the register still says permission_denied with
   * override_allowed, ask then. Returns null when the approval was declined.
   */
  const withApproval = useCallback(
    async <T,>(subject: OverrideSubject, title: string, quote: string | null, exec: (overrideId: string | null) => Promise<T>, minRole: Role = MIN_ROLE[subject.action]): Promise<T | null> => {
      const ask = async (needed: Role = minRole) => {
        const grant = await requestOverride({ subject, title, quote, minRole: needed });
        return grant;
      };
      if (!roleAtLeast(role, minRole)) {
        const grant = await ask();
        if (!grant) return null;
        return exec(grant.override_id);
      }
      try {
        return await exec(null);
      } catch (e) {
        if (e instanceof ApiError && e.code === "permission_denied" && e.details?.override_allowed) {
          // The register names the role it needs; the prompt asks for that one.
          const required = e.details.required_role;
          const grant = await ask(typeof required === "string" && ["server", "cashier", "manager", "finance", "admin"].includes(required) ? (required as Role) : minRole);
          if (!grant) return null;
          return exec(grant.override_id);
        }
        throw e;
      }
    },
    [requestOverride, role],
  );

  const addLine = useCallback(
    async (input: AddLineInput) => {
      const lineId = idempotencyKey();
      const idem = idempotencyKey();
      const now = new Date().toISOString();
      const optimistic: SnapshotLine = {
        id: lineId,
        product_id: input.product.id,
        name: input.product.name,
        kitchen_name: input.product.kitchen_name,
        sku: input.product.sku,
        quantity: input.quantity,
        unit_price: 0,
        open_price: input.openPrice ?? null,
        modifiers: (input.modifiers ?? []).map((m) => ({ modifier_id: `${m.group_id}:${m.product_id}`, product_id: m.product_id, name: m.name, quantity: m.quantity ?? 1, price: m.price, group_id: m.group_id })),
        notes: input.notes ?? null,
        seat_no: input.seat ?? null,
        source: "pos",
        round_id: null,
        status: input.hold ? "held" : "pending",
        fire_round: null,
        fired_at: null,
        voided_at: null,
        void_reason: null,
        amounts: { base: 0, discount: 0, net: 0, fee: 0, tax: 0, total: 0 },
        taxes: [],
        tax_class_id: input.product.tax_class_id,
        tags: input.product.tags,
        category_id: input.product.category_id,
        sort: Number.MAX_SAFE_INTEGER,
        added_by: null,
        created_at: now,
        optimistic: true,
      };
      holdPendingLine(orderId, optimistic);
      qc.setQueryData<OrderSnapshot>(key, (s) => (s ? { ...s, lines: [...s.lines, optimistic] } : s));
      const body: reg.LineInput = {
        line_id: lineId,
        product_id: input.product.id,
        quantity: input.quantity,
        modifiers: input.modifiers?.map((m) => ({ group_id: m.group_id, product_id: m.product_id, quantity: m.quantity ?? 1 })),
        notes: input.notes ?? null,
        seat_no: input.seat ?? null,
        hold: input.hold ?? false,
        open_price: input.openPrice ?? null,
      };
      const label = `Added ${input.product.name}${input.quantity > 1 ? ` ×${input.quantity}` : ""}`;
      // Taps that come while an add is on its way wait for it and then go to the register together, in one request
      // (round 8, 4: thirty taps took thirty round trips one after another). The batch still takes its turn after the
      // request before it, with the version that one returned, so a burst never conflicts with itself (C-6); a conflict
      // is another station's.
      let batch: AddBatch | null = null;
      try {
        // A request that may have reached the register (its reply never came) is sent again exactly as it was, with the
        // same lines and key: the register then replays its answer instead of refusing the key for a different request.
        // Its version is kept here, because the order's version on screen moves on when the station hears the add landed.
        const send = (b: AddBatch, overrideId: string | null) => {
          let sent: number | null = null;
          // A version conflict means another station changed the order meanwhile; adding is safe to replay.
          const exec = () =>
            run(
              (expected) => {
                // Its turn has come: the lines that waited for it are the batch, and later taps start the next one.
                b.open = false;
                // A version conflict proves the request did not land, so its unversioned retry (expected null) goes as it is.
                sent = b.maybeLanded && expected !== null ? sent : expected;
                return reg.addLines(api, orderId, b.bodies, { key: b.key, expectedVersion: sent, overrideId });
              },
              {
                onConflict: "retry-unversioned",
                // An add replayed after a lost reply keeps the version it was first sent with, so its 409 may be this
                // station's own earlier add landing on reconnect: no news to anyone then.
                onRetried: () => {
                  if (!b.maybeLanded) notify({ text: `The order changed on another station. Your ${b.bodies.length === 1 ? "1 new line was" : `${b.bodies.length} new lines were`} kept`, tone: "info", orderId }, 4000);
                },
              },
            );
          // An add that never reached the register keeps its lines on screen and is sent again, with the same line ids
          // and key (so it lands once), as soon as the station is back online.
          // The register takes a request's lines all or none: when it refuses a batch (one line sold out, over its day's
          // cap), each line goes again on its own, so only the line it refuses is lost. A batch whose reply may have been
          // lost is never split: it may have landed.
          const split = async (e: unknown): Promise<AddBatchResult> => {
            if (b.bodies.length < 2 || b.maybeLanded || !(e instanceof ApiError) || e.status < 400 || e.status >= 500 || e.code === "version_conflict") throw e;
            const refused = new Map<string, unknown>();
            let snap: OrderSnapshot | null = null;
            for (const one of b.bodies) {
              try {
                snap = (await run((expected) => reg.addLines(api, orderId, [one], { expectedVersion: expected, overrideId }), { onConflict: "retry-unversioned" })) ?? snap;
              } catch (err) {
                refused.set(one.line_id, err);
              }
            }
            return { snap, refused };
          };
          return (async (): Promise<AddBatchResult> => {
            for (;;) {
              try {
                return { snap: await exec(), refused: new Map() };
              } catch (e) {
                if (!unreachable(e)) return split(e);
                b.maybeLanded = true;
                reportUnreachable();
                notify({ text: b.bodies.length === 1 ? `Offline · ${b.names[0]} is kept` : `Offline · ${b.bodies.length} new lines are kept`, remedy: "It goes to the register as soon as the connection is back.", tone: "info", orderId }, 8000);
                await whenOnline();
              }
            }
          })();
        };
        const queued = (overrideId: string | null): Promise<OrderSnapshot | null> => {
          // An open price goes on its own (it may need an approval the other lines do not).
          const batchable = overrideId == null && body.open_price == null;
          const open = batchable ? addBatches.get(orderId) : undefined;
          // Each tap learns its own line's fate.
          const mine = (r: AddBatchResult) => {
            if (r.refused.has(lineId)) throw r.refused.get(lineId);
            return r.snap;
          };
          if (open?.open) {
            open.bodies.push(body);
            open.names.push(input.product.name);
            batch = open;
            return open.done.then(mine);
          }
          const b: AddBatch = { bodies: [body], names: [input.product.name], key: idem, open: batchable, maybeLanded: false, reported: new Set(), done: Promise.resolve({ snap: null, refused: new Map() }) };
          batch = b;
          if (b.open) addBatches.set(orderId, b);
          b.done = send(b, overrideId).finally(() => {
            if (addBatches.get(orderId) === b) addBatches.delete(orderId);
          });
          return b.done.then(mine);
        };
        const snap = input.openPrice != null ? await withApproval({ action: "lines.add_open_price", target_kind: "order", target_id: orderId, args: { lines: [{ line_id: lineId, product_id: input.product.id, quantity: input.quantity, open_price: input.openPrice }] } }, `Add ${input.product.name} at ${money(input.openPrice)}`, "Open price · needs a manager", queued) : await queued(null);
        if (!snap) {
          releasePendingLine(orderId, lineId);
          qc.setQueryData<OrderSnapshot>(key, (s) => (s ? { ...s, lines: s.lines.filter((l) => l.id !== lineId) } : s));
          return null;
        }
        showUndo(label, async () => {
          try {
            await run((expected) => reg.voidLine(api, orderId, lineId, { reason_text: "Undo" }, { expectedVersion: expected }));
          } catch (e) {
            fail(e);
          }
        }, { screen: true });
        return snap;
      } catch (e) {
        releasePendingLine(orderId, lineId);
        qc.setQueryData<OrderSnapshot>(key, (s) => (s ? { ...s, lines: s.lines.filter((l) => l.id !== lineId) } : s));
        // A refusal is said once per batch, not once per tap it turned down.
        const b = batch as AddBatch | null;
        const said = toApiError(e).message;
        if (!b?.reported.has(said)) fail(e);
        b?.reported.add(said);
        return null;
      } finally {
        releasePendingLine(orderId, lineId);
      }
    },
    [api, fail, key, money, notify, orderId, qc, run, showUndo, withApproval],
  );

  const patchLine = useCallback(
    async (lineId: string, patch: reg.LinePatch, undoLabel?: string | null) => {
      try {
        const before = snapshot()?.lines.find((l) => l.id === lineId);
        const snap = await run((expected) => reg.updateLine(api, orderId, lineId, patch, { expectedVersion: expected }));
        if (snap && undoLabel && before) {
          const revert: reg.LinePatch = {};
          if (patch.hold !== undefined) revert.hold = before.status === "held";
          if (patch.quantity !== undefined) revert.quantity = before.quantity;
          if (patch.seat_no !== undefined) revert.seat_no = before.seat_no;
          if (patch.notes !== undefined) revert.notes = before.notes;
          showUndo(undoLabel, async () => {
            try {
              await run((expected) => reg.updateLine(api, orderId, lineId, revert, { expectedVersion: expected }));
            } catch (e) {
              fail(e);
            }
          }, { screen: true });
        }
        return snap;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run, showUndo, snapshot],
  );

  /** Remove (before sending) or Void (after sending, with manager approval). */
  const removeLine = useCallback(
    async (line: SnapshotLine, reason: { id?: string; text: string }, quantity?: number) => {
      const body = { reason_id: reason.id, reason_text: reason.id ? undefined : reason.text, quantity };
      try {
        if (line.status === "fired") {
          const qty = quantity ?? line.quantity;
          return await withApproval(
            { action: "lines.void_fired", target_kind: "order_line", target_id: line.id, args: { quantity: qty } },
            `Void ${line.name} ×${qty}`,
            // A part of the line names its count, not the whole line's price: the register has not priced the part yet.
            `${qty < line.quantity ? `${qty} of ${line.quantity} · already sent` : `already sent · ${money(line.amounts.base)}`}${line.kitchen_name ? " · prints a void ticket" : ""}`,
            (overrideId) => run((expected) => reg.voidLine(api, orderId, line.id, body, { expectedVersion: expected, overrideId })),
          );
        }
        return await run((expected) => reg.voidLine(api, orderId, line.id, body, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, money, orderId, run, withApproval],
  );

  // A second tap while the first Send is on the wire joins it: sent again with the old version, it came back 409 and
  // said the order had changed on another station.
  const send = useCallback(() => {
    const inFlight = sending.get(orderId);
    if (inFlight) return inFlight;
    const request = (async () => {
      try {
        const res = await run((expected) => reg.fireOrder(api, orderId, {}, { expectedVersion: expected }));
        // Undoing an add once it is sent is a kitchen void, a Manager's: below that the Undo is not offered (C-5).
        if (res && !roleAtLeast(role, "manager")) useUiStore.getState().clearUndo();
        if (res) notify({ text: "Sent to the kitchen", tone: "success", orderId }, 3000);
        return res;
      } catch (e) {
        fail(e);
        return null;
      } finally {
        sending.delete(orderId);
      }
    })();
    sending.set(orderId, request);
    return request;
  }, [api, fail, notify, orderId, role, run]);

  const holdAllNew = useCallback(async () => {
    const s = snapshot();
    if (!s) return null;
    const ids = s.lines.filter((l) => l.status === "pending" && !l.optimistic).map((l) => l.id);
    if (!ids.length) return null;
    try {
      let last: OrderSnapshot | null = null;
      for (const id of ids) last = await run((expected) => reg.updateLine(api, orderId, id, { hold: true }, { expectedVersion: expected }));
      if (last) {
        showUndo(`Held ${ids.length} ${ids.length === 1 ? "line" : "lines"}`, async () => {
          try {
            for (const id of ids) await run((expected) => reg.updateLine(api, orderId, id, { hold: false }, { expectedVersion: expected }));
          } catch (e) {
            fail(e);
          }
        }, { screen: true });
      }
      return last;
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail, orderId, run, showUndo, snapshot]);

  const releaseHeld = useCallback(async () => {
    const s = snapshot();
    if (!s) return null;
    const ids = s.lines.filter((l) => l.status === "held").map((l) => l.id);
    try {
      let last: OrderSnapshot | null = null;
      for (const id of ids) last = await run((expected) => reg.updateLine(api, orderId, id, { hold: false }, { expectedVersion: expected }));
      return last;
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail, orderId, run, snapshot]);

  const changeType = useCallback(
    async (input: reg.ChangeTypeInput) => {
      try {
        return await run((expected) => reg.changeOrderType(api, orderId, input, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const moveTable = useCallback(
    async (tableId: string) => {
      try {
        return await run((expected) => reg.moveTable(api, orderId, tableId, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const attachCustomer = useCallback(
    async (customerId: string) => {
      try {
        return await run((expected) => reg.attachCustomer(api, orderId, customerId, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const detachCustomer = useCallback(async () => {
    try {
      return await run((expected) => reg.detachCustomer(api, orderId, { expectedVersion: expected }));
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail, orderId, run]);

  const updateDetails = useCallback(
    async (patch: reg.DetailsPatch) => {
      try {
        return await run((expected) => reg.updateOrderDetails(api, orderId, patch, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const cancel = useCallback(
    async (reason: string) => {
      try {
        return await run((expected) => reg.cancelOrder(api, orderId, reason, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const markReady = useCallback(async () => {
    try {
      return await run((expected) => reg.markReady(api, orderId, { expectedVersion: expected }));
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail, orderId, run]);

  /** Apply a manual rule. The rule's own minimum role decides whether to ask a manager first. */
  const applyDiscount = useCallback(
    async (rule: ManualRule, enteredValue: number | null, reason: string | null, lineIds: string[] | null) => {
      const applicationId = idempotencyKey();
      const input: reg.AdjustmentInput = { application_id: applicationId, rule_key: rule.rule_key, entered_value: enteredValue, reason, line_ids: lineIds };
      const valueText = rule.value.type === "open" && enteredValue != null ? (rule.calc === "percent" ? formatBpsText(enteredValue) : money(enteredValue)) : null;
      try {
        // Above this role, the approver is shown what it does in money first: the register's dry run of it, never a
        // figure worked out here (final review B-P15). Without one the sheet still names the action.
        let effect: string | null = null;
        if (!roleAtLeast(role, rule.min_role)) {
          try {
            const dry = await reg.applyAdjustment(api, orderId, input, { dryRun: true });
            const adj = dry.data.adjustments.find((a) => a.manual_application_id === applicationId);
            if (adj) effect = `${adj.total === 0 ? "No change" : `${rule.kind === "fee" ? "Fee" : "Discount"} ${money(adj.total, { signed: true })}`} · New total ${money(dry.data.totals.total)}`;
          } catch {
            effect = null;
          }
        }
        return await withApproval(
          { action: "adjustments.apply_manual", target_kind: "order", target_id: orderId, args: { rule_key: rule.rule_key, entered_value: enteredValue, line_ids: lineIds } },
          `Apply ${rule.name}${valueText ? ` · ${valueText}` : ""}`,
          [effect, reason ? `Reason: ${reason}` : null].filter(Boolean).join(" · ") || null,
          (overrideId) => run((expected) => reg.applyAdjustment(api, orderId, input, { expectedVersion: expected, overrideId })),
          rule.min_role,
        );
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, money, orderId, role, run, withApproval],
  );

  const removeDiscount = useCallback(
    async (applicationId: string, ruleName: string, minRole: Role) => {
      try {
        return await withApproval(
          { action: "adjustments.remove", target_kind: "order", target_id: orderId, args: { application_id: applicationId } },
          `Remove ${ruleName}`,
          null,
          (overrideId) => run((expected) => reg.removeAdjustment(api, orderId, applicationId, { expectedVersion: expected, overrideId })),
          minRole,
        );
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run, withApproval],
  );

  /* ---- Bills: the register recomputes every split; the response is the only source of amounts. ---- */

  const splitEven = useCallback(
    async (n: number) => {
      try {
        return await run((expected) => reg.splitEven(api, orderId, n, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const splitBySeat = useCallback(
    async (shared: "even" | "manual") => {
      try {
        return await run((expected) => reg.splitBySeat(api, orderId, shared, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const allocate = useCallback(
    async (moves: reg.AllocationMove[], addChecks?: number) => {
      try {
        return await run((expected) => reg.allocateLines(api, orderId, moves, addChecks, { expectedVersion: expected }));
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run],
  );

  const unsplit = useCallback(async () => {
    try {
      return await run((expected) => reg.unsplit(api, orderId, { expectedVersion: expected }));
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail, orderId, run]);

  /** Pre-bill for one bill, or every unpaid bill when `checkId` is omitted; marks the table "bill requested". */
  const prebill = useCallback(
    async (checkId?: string | null) => {
      try {
        const res = await reg.printPrebill(api, orderId, checkId, { expectedVersion: snapshot()?.version ?? null });
        applySnapshot(qc, res.data);
        const n = res.jobs?.length ?? 0;
        notify({ text: n ? `Printing ${n === 1 ? "the pre-bill" : `${n} pre-bills`}` : "Pre-bill requested", remedy: n ? null : "No receipt printer is set up for this station.", tone: n ? "success" : "info", orderId }, 4000);
        for (const w of res.warnings) notify({ text: w, tone: "info", orderId }, 6000);
        return res.data;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, notify, orderId, qc, snapshot],
  );

  /* ---- Payments ---- */

  /** The bill's balance moved since it was loaded (payments.record replies 400 `validation` with `details.balance`): refresh so the prefilled amount follows the register. */
  const refreshIfBalanceChanged = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code === "validation" && e.details && typeof e.details.balance === "number") void qc.invalidateQueries({ queryKey: key });
    },
    [key, qc],
  );

  /** A dry run: the register's rounding and change for this tender and amount; nothing is recorded. */
  const previewPayment = useCallback(
    async (checkId: string, input: Omit<reg.PaymentInput, "payment_id" | "dry_run">): Promise<PaymentResult | null> => {
      try {
        return await reg.recordPayment(api, checkId, { ...input, payment_id: idempotencyKey(), dry_run: true });
      } catch (e) {
        refreshIfBalanceChanged(e);
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
        fail(e);
        return null;
      }
    },
    [api, fail, refreshIfBalanceChanged],
  );

  /**
   * Record a payment. The caller keeps `payment_id` for the whole attempt, so a
   * double tap or a retry after a timeout records once. Cashier+;
   * a Server gets the Manager approval sheet.
   */
  const pay = useCallback(
    async (check: CheckSnapshot, input: Omit<reg.PaymentInput, "dry_run">, tenderName: string, opts: { onRefused?: (e: ApiError) => void; dueCents?: number | null } = {}): Promise<PaymentResult | null> => {
      beginMutation(orderId);
      try {
        // The approver sees what the guest is charged: the amount, the tip and the total, as the register's dry run gave it (B-N1).
        const tip = input.tip_cents ?? 0;
        const due = opts.dueCents ?? null;
        const res = await withApproval(
          { action: "payments.record", target_kind: "order", target_id: orderId, args: { check_id: check.id, tender_type_id: input.tender_type_id, amount: input.amount, tip_cents: tip, reference: input.reference ?? null } },
          `Take ${money(due ?? input.amount)} by ${tenderName}`,
          [`${check.label} · balance ${money(check.balance)}`, `Amount ${money(input.amount)}`, tip ? `Tip ${money(tip)}` : null, due != null && due !== input.amount ? `Total charged ${money(due)}` : null].filter(Boolean).join(" · "),
          (overrideId) => reg.recordPayment(api, check.id, input, { key: input.payment_id, expectedVersion: snapshot()?.version ?? null, overrideId }),
        );
        if (!res) return null;
        applySnapshot(qc, res.data);
        for (const w of res.warnings) notify({ text: w, tone: "info", orderId }, 6000);
        return res;
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict") {
          await qc.invalidateQueries({ queryKey: key });
          notify({ text: "The order changed on another station", remedy: "Check the bill and try again.", tone: "info", orderId }, 6000);
          return null;
        }
        // The answer was lost (no reply, or the register failed while replying): read the order again before saying
        // anything. A payment the register recorded under this payment id is shown as taken; a retry reuses the id.
        if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
          const taken = await reg.getOrder(api, orderId).catch(() => null);
          const recorded = taken?.checks.flatMap((c) => c.payments).find((p) => p.id === input.payment_id && p.status === "recorded");
          if (taken && recorded) {
            applySnapshot(qc, taken);
            // The payment row as the register recorded it; nothing is added up here.
            return { data: taken, payment: { ...recorded, change_due: recorded.change_cents }, events: [], warnings: [] };
          }
        }
        refreshIfBalanceChanged(e);
        // The register's refusal is shown as it is given; the screen may also point at the field it names.
        if (e instanceof ApiError) opts.onRefused?.(e);
        fail(e);
        return null;
      } finally {
        endMutation(orderId);
      }
    },
    [api, beginMutation, endMutation, fail, key, money, notify, orderId, qc, refreshIfBalanceChanged, snapshot, withApproval],
  );

  /**
   * Send a payment to the card terminal. The register answers at once with a pending payment; the terminal's answer
   * arrives on the event stream. `intent_id` is kept by the caller for the attempt, so a retry never sends twice.
   */
  const startTerminal = useCallback(
    async (check: CheckSnapshot, input: { intent_id: string; tender_type_id: string; amount: number; tip_cents?: number }): Promise<PaymentIntent | null> => {
      try {
        const intent = await reg.startTerminalPayment(api, check.id, input, { key: input.intent_id, expectedVersion: snapshot()?.version ?? null });
        void qc.invalidateQueries({ queryKey: posKeys.paymentIntents(orderId) });
        return intent;
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict") await qc.invalidateQueries({ queryKey: key });
        refreshIfBalanceChanged(e);
        fail(e);
        return null;
      }
    },
    [api, fail, key, orderId, qc, refreshIfBalanceChanged, snapshot],
  );

  const cancelTerminal = useCallback(
    async (intentId: string) => {
      try {
        const intent = await reg.cancelTerminalPayment(api, intentId);
        void qc.invalidateQueries({ queryKey: posKeys.paymentIntents(orderId) });
        return intent;
      } catch (e) {
        void qc.invalidateQueries({ queryKey: posKeys.paymentIntents(orderId) });
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, qc],
  );

  /** Void a payment taken in error (Manager+, or a manager's approval bound to this payment). */
  const voidPayment = useCallback(
    async (payment: CheckPayment, reason: string) => {
      beginMutation(orderId);
      try {
        const res = await withApproval({ action: "payments.void", target_kind: "payment", target_id: payment.id, args: { amount: payment.amount } }, `Void ${money(payment.amount)} by ${payment.tender}`, `Reason: ${reason}`, (overrideId) => reg.voidPayment(api, payment.id, reason, { expectedVersion: snapshot()?.version ?? null, overrideId }));
        if (!res) return null;
        applySnapshot(qc, res.data);
        void qc.invalidateQueries({ queryKey: posKeys.paymentIntents(orderId) });
        notify({ text: res.void.status === "voided" ? `Voided ${money(payment.amount)} by ${payment.tender}` : `Voiding ${money(payment.amount)} on the terminal`, tone: "success", orderId }, 5000);
        return res;
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict") await qc.invalidateQueries({ queryKey: key });
        fail(e);
        return null;
      } finally {
        endMutation(orderId);
      }
    },
    [api, beginMutation, endMutation, fail, key, money, notify, orderId, qc, snapshot, withApproval],
  );

  const complete = useCallback(async () => {
    try {
      return await run((expected) => reg.completeOrder(api, orderId, { expectedVersion: expected }));
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail, orderId, run]);

  /** What would stop a reopen (a terminal payment, another business day, a refund), asked before any reason or PIN. */
  const reopenRefusal = useCallback(() => reg.reopenRefusal(api, orderId), [api, orderId]);

  /** Reopen a completed order (Manager+, same business day): the approval sheet for anyone below Manager. */
  const reopen = useCallback(
    async (reason: string) => {
      try {
        const res = await withApproval({ action: "orders.reopen", target_kind: "order", target_id: orderId, args: {} }, "Reopen this order", `Reason: ${reason}`, (overrideId) => run((expected) => reg.reopenOrder(api, orderId, reason, { expectedVersion: expected, overrideId })));
        // The reversal is said once, by the order's own note above the bill (ReopenedNote), not again in a toast (final2 B Low).
        return res;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, orderId, run, withApproval],
  );

  /* ---- Receipts and documents ---- */

  const printReceipt = useCallback(
    async (checkId: string) => {
      try {
        const jobs = await reg.printReceipt(api, checkId);
        notify({ text: jobs.length ? `Printing the receipt on ${jobs[0]!.printer_name}` : "Receipt queued", tone: "success", orderId }, 4000);
        return jobs;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, notify, orderId],
  );

  const sendReceipt = useCallback(
    async (checkId: string, channel: ReceiptChannel, destination?: string) => {
      try {
        const res = await reg.sendReceipt(api, checkId, channel, destination);
        for (const w of res.warnings) notify({ text: w, tone: "info", orderId }, 6000);
        return res.data;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, notify, orderId],
  );

  const issueInvoice = useCallback(
    async (checkId: string) => {
      try {
        const inv = await reg.issueInvoice(api, checkId);
        void qc.invalidateQueries({ queryKey: key });
        // A role that may read the PDF opens it from the receipt screen; only one that may not is sent to the back office (M5).
        notify({ text: `${inv.reused ? "Invoice" : "Invoice issued"} ${inv.invoice_no}`, remedy: mayReadInvoice ? undefined : "The PDF is in the back office under the order.", tone: "success", orderId }, 6000);
        return inv;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, key, notify, orderId, qc, mayReadInvoice],
  );

  /** Download the bill's issued invoice as a PDF (Safari and the iPad open it in their viewer). */
  const openInvoicePdf = useCallback(
    async (checkId: string, invoiceNo: string) => {
      try {
        const blob = await reg.invoicePdf(api, checkId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${invoiceNo}.pdf`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [api, fail],
  );

  /* ---- Refunds: the quote is the register's; Manager+ or an approval for the signed-in role. ---- */

  const quoteRefund = useCallback(
    async (checkId: string, request: RefundRequest, tenderSplit?: reg.TenderSplit) => {
      return reg.quoteRefund(api, checkId, request, tenderSplit);
    },
    [api],
  );

  /** `refund_id` doubles as the idempotency key; the caller keeps one per attempt so a retry after a timeout never refunds twice. */
  const refund = useCallback(
    async (check: CheckSnapshot, input: Omit<reg.RefundInput, "refund_id"> & { refund_id?: string }, total: number, tip = 0): Promise<RefundResult | null> => {
      const refundId = input.refund_id ?? idempotencyKey();
      beginMutation(orderId);
      try {
        const res = await withApproval({ action: "refunds.create", target_kind: "check", target_id: check.id, args: { request: input.request, tender_split: input.tender_split, total, ...(tip > 0 ? { tip } : {}) } }, tip > 0 ? `Refund ${money(total)} and a ${money(tip)} tip` : `Refund ${money(total)}`, `${check.label} · ${input.reason}`, (overrideId) => reg.createRefund(api, check.id, { ...input, refund_id: refundId }, { key: refundId, expectedVersion: snapshot()?.version ?? null, overrideId }));
        if (!res) return null;
        applySnapshot(qc, res.data);
        void qc.invalidateQueries({ queryKey: posKeys.refunds(orderId) });
        for (const w of res.warnings) notify({ text: w, tone: "info", orderId }, 6000);
        return res;
      } catch (e) {
        fail(e);
        return null;
      } finally {
        endMutation(orderId);
      }
    },
    [api, beginMutation, endMutation, fail, money, notify, orderId, qc, snapshot, withApproval],
  );

  const printRefundReceipt = useCallback(
    async (refundId: string) => {
      try {
        const jobs = await reg.printRefundReceipt(api, refundId);
        notify({ text: jobs.length ? `Printing the refund receipt on ${jobs[0]!.printer_name}` : "Refund receipt queued", tone: "success", orderId }, 4000);
        return jobs;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, notify, orderId],
  );

  /* ---- Scan to Order: a held round is accepted (sent) or rejected with a reason. ---- */

  const acceptRound = useCallback(
    async (roundId: string) => {
      try {
        const snap = await run((expected) => reg.acceptRound(api, roundId, { expectedVersion: expected }), { versioned: false });
        void qc.invalidateQueries({ queryKey: ["pos", "rounds"] });
        return snap;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, qc, run],
  );

  const rejectRound = useCallback(
    async (roundId: string, reason: string) => {
      try {
        const snap = await run((expected) => reg.rejectRound(api, roundId, reason, { expectedVersion: expected }), { versioned: false });
        void qc.invalidateQueries({ queryKey: ["pos", "rounds"] });
        return snap;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, qc, run],
  );

  /** Mark products sold out for today (after a QR order was rejected as sold out); the guest menu follows. */
  const markSoldOut = useCallback(
    async (productIds: string[]) => {
      try {
        const outletId = snapshot()?.outlet_id;
        if (!outletId) return null;
        for (const id of productIds) await reg.markSoldOut(api, outletId, id, "today");
        void qc.invalidateQueries({ queryKey: ["pos", "menu"] });
        void qc.invalidateQueries({ queryKey: ["pos", "stock", outletId] });
        return true;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, qc, snapshot],
  );

  /* ---- Printing ---- */

  const reprint = useCallback(
    async (jobId: string) => {
      try {
        const jobs = await reg.reprintJob(api, jobId);
        void qc.invalidateQueries({ queryKey: ["pos", "print-jobs"] });
        notify({ text: jobs.length ? `Reprinting on ${jobs[0]!.printer_name}` : "Reprint queued", tone: "success", orderId }, 4000);
        return jobs;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, notify, orderId, qc],
  );

  return useMemo(
    () => ({
      addLine,
      patchLine,
      removeLine,
      send,
      holdAllNew,
      releaseHeld,
      changeType,
      moveTable,
      attachCustomer,
      detachCustomer,
      updateDetails,
      cancel,
      markReady,
      applyDiscount,
      removeDiscount,
      splitEven,
      splitBySeat,
      allocate,
      unsplit,
      prebill,
      previewPayment,
      pay,
      startTerminal,
      cancelTerminal,
      voidPayment,
      complete,
      reopen,
      reopenRefusal,
      printReceipt,
      sendReceipt,
      issueInvoice,
      openInvoicePdf,
      mayReadInvoice,
      quoteRefund,
      refund,
      printRefundReceipt,
      acceptRound,
      rejectRound,
      markSoldOut,
      reprint,
      role,
    }),
    [addLine, patchLine, removeLine, send, holdAllNew, releaseHeld, changeType, moveTable, attachCustomer, detachCustomer, updateDetails, cancel, markReady, applyDiscount, removeDiscount, splitEven, splitBySeat, allocate, unsplit, prebill, previewPayment, pay, startTerminal, cancelTerminal, voidPayment, complete, reopen, reopenRefusal, printReceipt, sendReceipt, issueInvoice, openInvoicePdf, mayReadInvoice, quoteRefund, refund, printRefundReceipt, acceptRound, rejectRound, markSoldOut, reprint, role],
  );
}

export type OrderActions = ReturnType<typeof useOrderActions>;
