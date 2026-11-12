/**
 * A card-terminal simulator for development and tests: the other end of the built-in `simulator` payment provider.
 *
 *   pnpm --filter @sail/server sim:payments -- --port 8090 --api http://localhost:8080
 *
 * It keeps payments in memory and answers the provider's calls (start, status, cancel, void). Each payment ends the
 * way the terminal's next outcome says, by default `approve` after a short delay, and the result is posted to the
 * register as a signed webhook. Set the next outcome for a terminal with
 *
 *   curl -X POST localhost:8090/terminals/sim-1/next -H 'content-type: application/json' -d '{"outcome":"decline"}'
 *
 * Outcomes: approve, decline, timeout (the terminal never answers), duplicate (the approval webhook is delivered twice)
 * and late (the guest pays only after `lateMs`, after the register has given up, so the approval must be given back).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { SIMULATOR_SIGNATURE_HEADER, signSimulatorWebhook } from "../src/payments/simulator.js";

export const SIM_OUTCOMES = ["approve", "decline", "timeout", "duplicate", "late"] as const;
export type SimOutcome = (typeof SIM_OUTCOMES)[number];
type Status = "pending" | "approved" | "declined" | "cancelled" | "voided";
export type SimPayment = { id: string; merchantId: string; reference: string; terminalId: string; amount: number; currency: string; status: Status; webhookSecret: string };
export type Delivery = { url: string; headers: Record<string, string>; body: string };

export type SimulatorOptions = {
  port?: number;
  /** Where the register listens; webhooks go to `${apiUrl}/v1/webhooks/payments/simulator/{merchant_id}`. */
  apiUrl?: string;
  /** How long the terminal takes before its outcome. */
  delayMs?: number;
  lateMs?: number;
  /** Off: payments wait until `settle` is called (tests decide the timing). */
  auto?: boolean;
  /** How a webhook reaches the register. Defaults to an HTTP POST. */
  deliver?: (d: Delivery) => Promise<void>;
};

export type Simulator = {
  url: string;
  payments: Map<string, SimPayment>;
  deliveries: Delivery[];
  setNext: (terminalId: string, outcome: SimOutcome) => void;
  settle: (reference: string, outcome: SimOutcome) => Promise<void>;
  stop: () => Promise<void>;
};

const key = (merchantId: string, reference: string) => `${merchantId}/${reference}`;
const view = (p: SimPayment) => ({ id: p.id, reference: p.reference, status: p.status, amount: p.amount });

export async function startSimulator(opts: SimulatorOptions = {}): Promise<Simulator> {
  const apiUrl = (opts.apiUrl ?? "http://localhost:8080").replace(/\/$/, "");
  const delayMs = opts.delayMs ?? 1500;
  const lateMs = opts.lateMs ?? 150_000;
  const auto = opts.auto ?? true;
  const payments = new Map<string, SimPayment>();
  const next = new Map<string, SimOutcome>();
  const deliveries: Delivery[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const deliver =
    opts.deliver ??
    (async (d: Delivery) => {
      const res = await fetch(d.url, { method: "POST", headers: d.headers, body: d.body });
      if (!res.ok) console.warn(`[simulator] webhook answered ${res.status}: ${await res.text()}`);
    });

  const send = async (p: SimPayment, times = 1) => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: `payment.${p.status}`, created: Math.floor(Date.now() / 1000), payment: view(p) });
    const d: Delivery = { url: `${apiUrl}/v1/webhooks/payments/simulator/${p.merchantId}`, headers: { "content-type": "application/json", [SIMULATOR_SIGNATURE_HEADER]: signSimulatorWebhook(p.webhookSecret, body, new Date()) }, body };
    for (let i = 0; i < times; i++) {
      deliveries.push(d);
      await deliver(d).catch((e: unknown) => console.warn(`[simulator] webhook failed: ${(e as Error).message}`));
    }
  };
  const later = (ms: number, fn: () => Promise<void>) => {
    const t = setTimeout(() => {
      timers.delete(t);
      void fn();
    }, ms);
    timers.add(t);
  };

  const settle = async (reference: string, outcome: SimOutcome) => {
    const p = [...payments.values()].find((x) => x.reference === reference);
    if (!p || p.status !== "pending") return;
    if (outcome === "timeout") return;
    if (outcome === "late") {
      later(lateMs, async () => {
        if (p.status !== "pending") return;
        p.status = "approved";
        await send(p);
      });
      return;
    }
    p.status = outcome === "decline" ? "declined" : "approved";
    await send(p, outcome === "duplicate" ? 2 : 1);
  };

  const read = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const parts = (req.url ?? "/").split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
      try {
        if (req.method === "GET" && parts[0] === "health") return json(res, 200, { ok: true });
        if (req.method === "POST" && parts[0] === "terminals" && parts[2] === "next" && parts.length === 3) {
          const outcome = (await read(req)).outcome as SimOutcome;
          if (!SIM_OUTCOMES.includes(outcome)) return json(res, 400, { error: `outcome is one of ${SIM_OUTCOMES.join(", ")}` });
          next.set(parts[1]!, outcome);
          return json(res, 200, { terminal_id: parts[1], next: outcome });
        }
        if (req.method === "POST" && parts[0] === "payments" && parts.length === 1) {
          const b = await read(req);
          const merchantId = String(b.merchant_id);
          const reference = String(b.reference);
          // The reference is the idempotency key: a retried start returns the payment already on the terminal.
          const existing = payments.get(key(merchantId, reference));
          if (existing) return json(res, 200, view(existing));
          const p: SimPayment = { id: `sim_${randomUUID()}`, merchantId, reference, terminalId: String(b.terminal_id), amount: Number(b.amount), currency: String(b.currency), status: "pending", webhookSecret: String(b.webhook_secret) };
          payments.set(key(merchantId, reference), p);
          const outcome = next.get(p.terminalId) ?? "approve";
          next.delete(p.terminalId);
          if (auto) later(delayMs, () => settle(reference, outcome));
          return json(res, 201, view(p));
        }
        if (parts[0] === "payments" && parts.length >= 3) {
          const p = payments.get(key(parts[1]!, parts[2]!));
          if (!p) return json(res, 404, { error: "no such payment" });
          if (req.method === "GET" && parts.length === 3) return json(res, 200, view(p));
          if (req.method === "POST" && parts[3] === "cancel") {
            if (p.status === "pending") {
              p.status = "cancelled";
              await send(p);
            }
            return json(res, 200, view(p));
          }
          if (req.method === "POST" && parts[3] === "void") {
            if (p.status === "approved") p.status = "voided";
            if (p.status !== "voided") return json(res, 409, { error: `cannot void a ${p.status} payment`, ...view(p) });
            return json(res, 200, view(p));
          }
        }
        return json(res, 404, { error: "not found" });
      } catch (e) {
        return json(res, 500, { error: (e as Error).message });
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    payments,
    deliveries,
    setNext: (terminalId, outcome) => next.set(terminalId, outcome),
    settle,
    stop: async () => {
      for (const t of timers) clearTimeout(t);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const sim = await startSimulator({ port: Number(arg("port") ?? 8090), apiUrl: arg("api") ?? "http://localhost:8080" });
  console.log(`Terminal simulator on ${sim.url}. Point the register at it with PAYMENT_SIMULATOR_URL=${sim.url}`);
  const shutdown = () => void sim.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
