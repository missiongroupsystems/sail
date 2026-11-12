"use client";

import { useQueryClient } from "@tanstack/react-query";
import { formatBpsText, useLocale } from "@sail/ui";
import { useCallback, useMemo } from "react";
import { ApiError, idempotencyKey, toApiError } from "@/lib/api";
import * as reg from "../api/register";
import type { CheckPayment, CheckSnapshot, CompiledProduct, ManualRule, MutationResult, OrderSnapshot, OrderType, OverrideAction, OverrideSubject, PaymentIntent, PaymentResult, ReceiptChannel, RefundRequest, RefundResult, Role, SnapshotLine } from "../api/types";
import { useSessionStore } from "../state/session";
import { useUiStore } from "../state/ui";
import { applySnapshot, posKeys } from "./queries";
import { useApi } from "./useApi";

const RANK: Record<Role, number> = { server: 10, cashier: 20, manager: 30, finance: 40, admin: 50 };
const MIN_ROLE: Record<OverrideAction, Role> = { "lines.void_fired": "manager", "lines.add_open_price": "manager", "adjustments.apply_manual": "server", "adjustments.remove": "server", "payments.record": "cashier", "refunds.create": "manager", "orders.reopen": "manager", "payments.void": "manager" };

export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  return role ? RANK[role] >= RANK[min] : false;
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
  const { money } = useLocale();
  const { notify, showUndo, beginMutation, endMutation, requestOverride } = useUiStore.getState();

  const key = useMemo(() => posKeys.order(orderId), [orderId]);
  const snapshot = useCallback(() => qc.getQueryData<OrderSnapshot>(key), [qc, key]);

  const fail = useCallback(
    (e: unknown) => {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert", orderId }, 8000);
    },
    [notify, orderId],
  );

  /**
   * Run a register mutation with `expected_version`, keep the snapshot it
   * returns, and handle a version conflict: refetch, then either retry once
   * without a version (safe for adding lines) or tell the user in one line.
   */
  const run = useCallback(
    async (exec: (expectedVersion: number | null) => Promise<MutationResult>, opts: { versioned?: boolean; onConflict?: "retry-unversioned" | "refetch"; onRetried?: () => void } = {}): Promise<OrderSnapshot | null> => {
      beginMutation(orderId);
      try {
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
      const ask = async () => {
        const grant = await requestOverride({ subject, title, quote });
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
          const grant = await ask();
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
      try {
        // A version conflict means another station changed the order meanwhile; adding is safe to replay.
        const exec = (overrideId: string | null) =>
          run((expected) => reg.addLines(api, orderId, [body], { key: idem, expectedVersion: expected, overrideId }), {
            onConflict: "retry-unversioned",
            onRetried: () => notify({ text: "Your 1 new line was kept", tone: "info", orderId }, 4000),
          });
        const snap = input.openPrice != null ? await withApproval({ action: "lines.add_open_price", target_kind: "order", target_id: orderId, args: { lines: [{ line_id: lineId, product_id: input.product.id, quantity: input.quantity, open_price: input.openPrice }] } }, `Add ${input.product.name} at ${money(input.openPrice)}`, "Open price · needs a manager", exec) : await exec(null);
        if (!snap) {
          qc.setQueryData<OrderSnapshot>(key, (s) => (s ? { ...s, lines: s.lines.filter((l) => l.id !== lineId) } : s));
          return null;
        }
        showUndo(label, async () => {
          try {
            await run((expected) => reg.voidLine(api, orderId, lineId, { reason_text: "Undo" }, { expectedVersion: expected }));
          } catch (e) {
            fail(e);
          }
        });
        return snap;
      } catch (e) {
        qc.setQueryData<OrderSnapshot>(key, (s) => (s ? { ...s, lines: s.lines.filter((l) => l.id !== lineId) } : s));
        fail(e);
        return null;
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
          });
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
            `already sent · ${money(line.amounts.total)}${line.kitchen_name ? " · prints a void ticket" : ""}`,
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

  const send = useCallback(async () => {
    try {
      return await run((expected) => reg.fireOrder(api, orderId, {}, { expectedVersion: expected }));
    } catch (e) {
      fail(e);
      return null;
    }
  }, [api, fail, orderId, run]);

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
        });
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
        return await withApproval(
          { action: "adjustments.apply_manual", target_kind: "order", target_id: orderId, args: { rule_key: rule.rule_key, entered_value: enteredValue, line_ids: lineIds } },
          `Apply ${rule.name}${valueText ? ` · ${valueText}` : ""}`,
          reason ? `Reason: ${reason}` : null,
          (overrideId) => run((expected) => reg.applyAdjustment(api, orderId, input, { expectedVersion: expected, overrideId })),
          rule.min_role,
        );
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, money, orderId, run, withApproval],
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
    async (check: CheckSnapshot, input: Omit<reg.PaymentInput, "dry_run">, tenderName: string): Promise<PaymentResult | null> => {
      beginMutation(orderId);
      try {
        const res = await withApproval(
          { action: "payments.record", target_kind: "order", target_id: orderId, args: { check_id: check.id, tender_type_id: input.tender_type_id, amount: input.amount, tip_cents: input.tip_cents ?? 0, reference: input.reference ?? null } },
          `Take ${money(input.amount)} by ${tenderName}`,
          `${check.label} · balance ${money(check.balance)}`,
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
        refreshIfBalanceChanged(e);
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
    async (check: CheckSnapshot, input: { intent_id: string; tender_type_id: string; amount: number }): Promise<PaymentIntent | null> => {
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

  /** Reopen a completed order (Manager+, same business day): the approval sheet for anyone below Manager. */
  const reopen = useCallback(
    async (reason: string) => {
      try {
        return await withApproval({ action: "orders.reopen", target_kind: "order", target_id: orderId, args: {} }, "Reopen this order", `Reason: ${reason}`, (overrideId) => run((expected) => reg.reopenOrder(api, orderId, reason, { expectedVersion: expected, overrideId })));
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
        notify({ text: `${inv.reused ? "Invoice" : "Invoice issued"} ${inv.invoice_no}`, remedy: "The PDF is in the back office under the order.", tone: "success", orderId }, 6000);
        return inv;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [api, fail, key, notify, orderId, qc],
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
    async (check: CheckSnapshot, input: Omit<reg.RefundInput, "refund_id"> & { refund_id?: string }, total: number): Promise<RefundResult | null> => {
      const refundId = input.refund_id ?? idempotencyKey();
      beginMutation(orderId);
      try {
        const res = await withApproval({ action: "refunds.create", target_kind: "check", target_id: check.id, args: { request: input.request, tender_split: input.tender_split, total } }, `Refund ${money(total)}`, `${check.label} · ${input.reason}`, (overrideId) => reg.createRefund(api, check.id, { ...input, refund_id: refundId }, { key: refundId, expectedVersion: snapshot()?.version ?? null, overrideId }));
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
      printReceipt,
      sendReceipt,
      issueInvoice,
      quoteRefund,
      refund,
      printRefundReceipt,
      acceptRound,
      rejectRound,
      reprint,
      role,
    }),
    [addLine, patchLine, removeLine, send, holdAllNew, releaseHeld, changeType, moveTable, attachCustomer, detachCustomer, updateDetails, cancel, markReady, applyDiscount, removeDiscount, splitEven, splitBySeat, allocate, unsplit, prebill, previewPayment, pay, startTerminal, cancelTerminal, voidPayment, complete, reopen, printReceipt, sendReceipt, issueInvoice, quoteRefund, refund, printRefundReceipt, acceptRound, rejectRound, reprint, role],
  );
}

export type OrderActions = ReturnType<typeof useOrderActions>;
