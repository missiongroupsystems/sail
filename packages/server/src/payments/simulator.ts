import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { WebhookRejected, type PaymentProvider, type ProviderPayment, type ProviderPaymentStatus } from "./provider.js";

/**
 * The built-in `simulator` provider: a client for the terminal simulator in `scripts/payment-simulator.ts`, for
 * development and tests. It speaks a small HTTP protocol and signs its webhooks the way a real provider would, so the
 * register's path from start to webhook is the one a real provider takes. It has no account store of its own, so the
 * register tells it which secret to sign the merchant's webhooks with.
 */
export const SIMULATOR_SIGNATURE_HEADER = "sail-simulator-signature";
/** Webhooks older (or newer) than this are refused, so a captured delivery cannot be replayed later. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
const CALL_TIMEOUT_MS = 10_000;

export function signSimulatorWebhook(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const Status = z.enum(["pending", "approved", "declined", "cancelled", "voided"]);
const PaymentBody = z.object({ id: z.string().min(1).max(100), status: Status, amount: z.number().int().min(0) });
const WebhookBody = z.object({ id: z.string().min(1).max(100), type: z.string().max(60), created: z.number().int(), payment: PaymentBody.extend({ reference: z.uuid() }) });

function baseUrl(): string {
  const url = config().PAYMENT_SIMULATOR_URL;
  if (!url) throw new Error("PAYMENT_SIMULATOR_URL is not set: start the terminal simulator (scripts/payment-simulator.ts) and point the register at it");
  return url.replace(/\/$/, "");
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`simulator ${method} ${path} answered ${res.status}`);
  return res.json();
}

const toPayment = (raw: unknown): ProviderPayment | null => {
  if (raw == null) return null;
  const p = PaymentBody.parse(raw);
  return { providerRef: p.id, status: p.status, amount: p.amount };
};

export const simulatorProvider: PaymentProvider = {
  name: "simulator",
  async startPayment({ account, reference, terminalId, amount, currency }) {
    const p = toPayment(await call("POST", "/payments", { merchant_id: account.merchantId, webhook_secret: account.webhookSecret, reference, terminal_id: terminalId, amount, currency }));
    if (!p) throw new Error("simulator did not create the payment");
    return { providerRef: p.providerRef };
  },
  async getPayment({ account, reference }) {
    return toPayment(await call("GET", `/payments/${encodeURIComponent(account.merchantId)}/${encodeURIComponent(reference)}`));
  },
  async cancelPayment({ account, reference }): Promise<ProviderPaymentStatus> {
    const p = toPayment(await call("POST", `/payments/${encodeURIComponent(account.merchantId)}/${encodeURIComponent(reference)}/cancel`, {}));
    // Never reached the terminal: there is nothing to stop.
    return p?.status ?? "cancelled";
  },
  async voidPayment({ account, reference, amount }) {
    const p = toPayment(await call("POST", `/payments/${encodeURIComponent(account.merchantId)}/${encodeURIComponent(reference)}/void`, { amount }));
    if (!p || p.status !== "voided") throw new Error(`simulator did not void ${reference}`);
  },
  verifyWebhook({ headers, body, secret, now }) {
    const header = headers.get(SIMULATOR_SIGNATURE_HEADER) ?? "";
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!parts.v1 || !Number.isInteger(t)) throw new WebhookRejected("missing or malformed signature");
    if (Math.abs(now.getTime() / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS) throw new WebhookRejected("signature timestamp outside the tolerance");
    const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
    const given = Buffer.from(parts.v1);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookRejected("signature does not match");
    let parsed: z.infer<typeof WebhookBody>;
    try {
      parsed = WebhookBody.parse(JSON.parse(body));
    } catch {
      throw new WebhookRejected("body is not a simulator event");
    }
    return { eventId: parsed.id, reference: parsed.payment.reference, providerRef: parsed.payment.id, status: parsed.payment.status, amount: parsed.payment.amount };
  },
};
