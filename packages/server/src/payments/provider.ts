/**
 * The seam between the register and a payment provider (a card-terminal service). A provider is a small client: it
 * never touches the database and never runs inside a request transaction. The worker calls it after the transaction
 * that asked for the call has committed, and the webhook route hands it the raw request to verify.
 *
 * Amounts are integers in the currency's minor unit, as everywhere in Sail. `reference` is the register's intent id:
 * the provider must accept it as an idempotency key, so a retried start never charges twice.
 */
export type ProviderPaymentStatus = "pending" | "approved" | "declined" | "cancelled" | "voided";

/** What the register knows about the merchant's account with this provider. */
export type ProviderAccount = { merchantId: string; webhookSecret: string };

export type ProviderPayment = { providerRef: string; status: ProviderPaymentStatus; amount: number };

/** A verified webhook. Everything in it came from outside: the register checks it against the intent before acting. */
export type ProviderEvent = { eventId: string; reference: string; providerRef: string; status: ProviderPaymentStatus; amount: number };

export interface PaymentProvider {
  readonly name: string;
  /** Ask the terminal to take `amount` (bill amount plus tip). Returns once the terminal has the payment, not when it is paid. */
  startPayment(input: { account: ProviderAccount; reference: string; terminalId: string; amount: number; currency: string }): Promise<{ providerRef: string }>;
  /** Where a payment stands now; the worker polls this when no webhook has arrived. */
  getPayment(input: { account: ProviderAccount; reference: string; providerRef: string | null }): Promise<ProviderPayment | null>;
  /** Stop a payment that is still on the terminal. Returns the status it ended in: `approved` when it was too late to stop. */
  cancelPayment(input: { account: ProviderAccount; reference: string; providerRef: string | null }): Promise<ProviderPaymentStatus>;
  /** Give an approved payment back in full (a void before settlement, a refund after). Idempotent by reference. */
  voidPayment(input: { account: ProviderAccount; reference: string; providerRef: string; amount: number }): Promise<void>;
  /** Check the signature and freshness of a webhook and parse it. Throws `WebhookRejected` for anything else. */
  verifyWebhook(input: { headers: Headers; body: string; secret: string; now: Date }): ProviderEvent;
}

export class WebhookRejected extends Error {}

const providers = new Map<string, PaymentProvider>();

export function registerPaymentProvider(p: PaymentProvider) {
  if (providers.has(p.name)) throw new Error(`payment provider ${p.name} is already registered`);
  providers.set(p.name, p);
}

export function paymentProvider(name: string): PaymentProvider | null {
  return providers.get(name) ?? null;
}

export function paymentProviderNames(): string[] {
  return [...providers.keys()];
}
