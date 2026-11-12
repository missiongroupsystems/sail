"use client";

import { Badge, Button, ConnectionIndicator, cx, deviceLocale, deviceTimeZone, EmptyState, InlineError, LocaleProvider, SegmentedControl, TopBar, useLocale, type ConnectionStatus, type LocaleSettings } from "@sail/ui";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ApiError, idempotencyKey } from "@/lib/api";
import { merchantLocale } from "@/lib/locale";
import { createPosApi, POS_API_URL, type PosApi } from "@/pos/api/client";
import { actOnKitchenTicket, getMerchant, kitchenAllDay, listEvents, listKitchenTickets } from "@/pos/api/register";
import type { AllDayItem, KitchenTicket, KitchenTicketLine, Station } from "@/pos/api/types";
import { OutletStream } from "@/pos/events/stream";
import { useNow } from "@/pos/lib/device";
import { formatElapsed, ORDER_TYPE_LABEL } from "@/pos/lib/format";
import { useThemeScheduler } from "@/pos/lib/theme";
import { PairingScreen } from "@/pos/screens/PairingScreen";
import { useThemeStore, type ThemeMode } from "@/pos/state/ui";
import { useDisplayStore } from "./state";

const DEVICE_LOCALE: LocaleSettings = { currency: null, currencyExponent: null, locale: deviceLocale(), timeZone: deviceTimeZone() };

let client: PosApi | null = null;
/** One register client for the display, reading the display station's token; a 401 (station re-paired or archived) un-pairs the screen. */
function kdsApi(): PosApi {
  client ??= createPosApi({ getToken: () => useDisplayStore.getState().token, onUnauthenticated: () => useDisplayStore.getState().unpair() });
  return client;
}

const keys = { merchant: ["kds", "merchant"] as const, tickets: ["kds", "tickets"] as const, allDay: ["kds", "all-day"] as const };

/**
 * The kitchen display (/kds): a paired display station shows the open tickets of
 * its destinations in fired order, with elapsed time, and bumps them with a tap.
 * No PIN: the screen is a wall fixture, and what it may see is decided by the
 * register from the station token.
 */
export default function KdsApp() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 }, mutations: { retry: false } } }));
  const token = useDisplayStore((s) => s.token);
  const station = useDisplayStore((s) => s.station);
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider settings={DEVICE_LOCALE}>{token && station ? <Board station={station} /> : <Pairing />}</LocaleProvider>
    </QueryClientProvider>
  );
}

function Pairing() {
  const setPaired = useDisplayStore((s) => s.setPaired);
  const [notDisplay, setNotDisplay] = useState<string | null>(null);
  return (
    <>
      {notDisplay ? (
        <p role="alert" className="absolute inset-x-0 top-0 bg-surface px-8 py-3 text-body text-status-alert hairline-b">
          {notDisplay} is a POS station. Pair this screen with a kitchen display station, or open /pos on the iPad.
        </p>
      ) : null}
      <PairingScreen
        device="screen"
        hint="In the back office, open Settings › Stations, choose the kitchen display station and press “Pair an iPad”. Enter the 6 digits here."
        onPaired={(token, station: Station) => (station.kind === "display" ? setPaired(token, station) : setNotDisplay(station.name))}
      />
    </>
  );
}

function Board({ station }: { station: Station }) {
  const api = kdsApi();
  const merchant = useQuery({ queryKey: keys.merchant, queryFn: () => getMerchant(api), staleTime: 10 * 60_000 });
  if (!merchant.data) {
    return (
      <main className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-bg px-8">
        {merchant.error ? <Unpaired error={merchant.error} /> : null}
      </main>
    );
  }
  return (
    <LocaleProvider settings={merchantLocale(merchant.data.settings)}>
      <Tickets station={station} warn={merchant.data.settings.kitchen_warn_minutes} late={merchant.data.settings.kitchen_late_minutes} />
    </LocaleProvider>
  );
}

function Unpaired({ error }: { error: unknown }) {
  const unpair = useDisplayStore((s) => s.unpair);
  return (
    <div className="flex flex-col items-start gap-4">
      <InlineError error={error as ApiError} />
      <Button variant="secondary" size="lg" onPress={unpair}>
        Pair this screen again
      </Button>
    </div>
  );
}

/** Live updates: the outlet stream signals, events.list catches up (also after a reconnect), and the ticket queries refetch. */
function useTicketStream(outletId: string): ConnectionStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  useEffect(() => {
    const api = kdsApi();
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: keys.tickets });
      void qc.invalidateQueries({ queryKey: keys.allDay });
    };
    const stream = new OutletStream({
      baseUrl: POS_API_URL,
      outletId,
      getToken: () => useDisplayStore.getState().token,
      fetchEvents: (after) => listEvents(api, outletId, after),
      // Ticket changes, and order changes that show on a ticket (a table move, a new type).
      onEvents: (events) => {
        if (events.some((e) => e.aggregate.kind === "kitchen_ticket" || e.type === "order.moved" || e.type === "order.type_changed")) refresh();
      },
      onStatus: (s) => setStatus(s),
      onConnected: (first) => {
        if (!first) refresh();
      },
    });
    stream.start();
    return () => stream.stop();
  }, [outletId, qc]);
  return status;
}

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "day", label: "Day" },
  { id: "service", label: "Service" },
];

function Tickets({ station, warn, late }: { station: Station; warn: number; late: number }) {
  const api = kdsApi();
  const qc = useQueryClient();
  const { clock } = useLocale();
  const now = useNow(1000);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  // A display station cannot read the outlet record, so the schedule uses the default service hours; the switch overrides it.
  useThemeScheduler(null);
  const status = useTicketStream(station.outlet_id);
  const tickets = useQuery({ queryKey: keys.tickets, queryFn: () => listKitchenTickets(api, station.outlet_id) });
  const allDay = useQuery({ queryKey: keys.allDay, queryFn: () => kitchenAllDay(api, station.outlet_id) });
  const settle = () => Promise.all([qc.invalidateQueries({ queryKey: keys.tickets }), qc.invalidateQueries({ queryKey: keys.allDay })]);
  const act = useMutation<KitchenTicket, ApiError, { id: string; action: "bump" | "recall"; key: string }>({
    mutationFn: ({ id, action, key }) => actOnKitchenTicket(api, id, action, { key }),
    onSettled: settle,
  });
  const pendingId = act.isPending ? act.variables?.id : null;
  const open = tickets.data?.data ?? [];
  const last = tickets.data?.last_bumped ?? null;

  return (
    <main className="flex h-dvh w-full flex-col bg-bg">
      <TopBar
        left={<span className="px-2 text-line text-ink">{station.name}</span>}
        title={<span className="text-ink-2">{open.length === 1 ? "1 ticket" : `${open.length} tickets`}</span>}
        right={
          <>
            <Button size="lg" variant="secondary" isDisabled={!last || act.isPending} onPress={() => last && act.mutate({ id: last.id, action: "recall", key: idempotencyKey() })} aria-label={last ? `Recall ${ticketTitle(last)}` : "Recall"}>
              {last ? `Recall ${ticketTitle(last)}` : "Recall"}
            </Button>
            <SegmentedControl aria-label="Theme" options={THEMES} selectedId={mode} onSelect={(id) => setMode(id as ThemeMode)} />
            <span className="px-2 text-line text-ink tabular">{clock(new Date(now))}</span>
            <ConnectionIndicator status={status} />
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <section aria-label="Tickets" className="min-h-0 flex-1 overflow-y-auto p-3">
          <InlineError error={tickets.error ?? act.error} className="mb-3" />
          {tickets.data && open.length === 0 ? <EmptyState title="No tickets" hint="Items appear here as soon as they are sent to the kitchen." /> : null}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-start gap-3">
            {open.map((t) => (
              <TicketCard key={t.id} ticket={t} now={now} warn={warn} late={late} pending={pendingId === t.id} onBump={() => act.mutate({ id: t.id, action: "bump", key: idempotencyKey() })} />
            ))}
          </div>
        </section>
        <AllDay items={allDay.data ?? []} />
      </div>
    </main>
  );
}

function ticketTitle(t: KitchenTicket): string {
  if (t.order_type === "dine_in" && t.table_name) return `Table ${t.table_name}`;
  return t.customer_name ? `${t.customer_name} · ${t.order_no}` : t.order_no;
}

function TicketCard({ ticket: t, now, warn, late, pending, onBump }: { ticket: KitchenTicket; now: number; warn: number; late: number; pending: boolean; onBump: () => void }) {
  const seconds = Math.max(0, (now - new Date(t.fired_at).getTime()) / 1000);
  const cancelled = t.status === "cancelled";
  const tone = cancelled ? "neutral" : seconds >= late * 60 ? "late" : seconds >= warn * 60 ? "warn" : "neutral";
  const items = t.lines.reduce((n, l) => n + l.quantity - l.voided_quantity, 0);
  const title = ticketTitle(t);
  const meta = [t.order_type === "dine_in" ? t.order_no : ORDER_TYPE_LABEL[t.order_type as keyof typeof ORDER_TYPE_LABEL], t.pax ? `${t.pax} ${t.pax === 1 ? "guest" : "guests"}` : null, t.server_name, t.round_no > 1 ? `round ${t.round_no}` : null].filter(Boolean).join(" · ");
  return (
    <AriaButton
      onPress={onBump}
      isDisabled={pending}
      aria-label={`${cancelled ? "Clear" : "Bump"} ${title}, ${items} ${items === 1 ? "item" : "items"}${tone === "late" ? ", late" : ""}${t.changed ? ", changed" : ""}${cancelled ? ", cancelled" : ""}`}
      className={cx(
        "press pos-touch flex flex-col overflow-hidden rounded-tile bg-surface text-left hairline outline-none",
        "data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated data-[disabled]:opacity-45",
      )}
    >
      <span aria-hidden className={cx("h-2 w-full shrink-0", tone === "late" ? "bg-status-alert" : tone === "warn" ? "bg-status-sent" : "bg-surface-2")} />
      <span className="flex items-start justify-between gap-3 px-4 pt-3">
        <span className={cx("min-w-0 truncate text-title", cancelled ? "text-ink-2 line-through" : "text-ink")}>{title}</span>
        <span className={cx("shrink-0 text-title tabular", tone === "late" ? "text-status-alert" : tone === "warn" ? "text-status-sent" : "text-ink-2")}>{formatElapsed(seconds)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2 px-4 pt-1 pb-2 text-body text-ink-2">
        <span className="min-w-0 truncate">{meta}</span>
        {tone === "late" ? <Badge tone="alert">Late</Badge> : null}
        {cancelled ? <Badge tone="alert">Cancelled</Badge> : null}
        {t.changed && !cancelled ? <Badge tone="alert">Changed</Badge> : null}
        {t.status === "recalled" ? <Badge tone="seated">Recalled</Badge> : null}
        {t.status === "in_progress" ? <Badge tone="sent">In progress</Badge> : null}
      </span>
      <span className="flex flex-col gap-2 px-4 pt-2 pb-4 hairline-t">
        {t.lines.map((l) => (
          <TicketLine key={l.id} line={l} />
        ))}
      </span>
    </AriaButton>
  );
}

function TicketLine({ line: l }: { line: KitchenTicketLine }) {
  const left = l.quantity - l.voided_quantity;
  const struck = left <= 0;
  return (
    <span className="flex items-start gap-3">
      <span className={cx("w-8 shrink-0 text-heading tabular", struck ? "text-ink-2 line-through" : "text-ink")}>{struck ? l.quantity : left}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("flex items-center gap-2 text-heading", struck ? "text-ink-2" : "text-ink")}>
          <span className={cx("min-w-0 break-words", struck && "line-through")}>{l.name}</span>
          {l.seat_no != null ? <span className="shrink-0 rounded-chip bg-surface-2 px-2 text-caption text-ink-2 tabular">S{l.seat_no}</span> : null}
        </span>
        {l.modifiers.map((m, i) => (
          <span key={i} className={cx("block pl-3 text-line text-ink-2", struck && "line-through")}>
            · {m}
          </span>
        ))}
        {l.notes ? <span className={cx("block pl-3 text-line text-ink italic", struck && "text-ink-2 line-through")}>{l.notes}</span> : null}
        {struck ? <span className="block pl-3 text-caption text-status-alert">Voided</span> : l.voided_quantity > 0 ? <span className="block pl-3 text-caption text-status-alert line-through">{l.voided_quantity} voided</span> : null}
      </span>
    </span>
  );
}

function AllDay({ items }: { items: AllDayItem[] }) {
  return (
    <aside aria-label="All day" className="flex w-[280px] shrink-0 flex-col hairline-l bg-surface">
      <h2 className="px-4 pt-4 pb-2 text-caption text-ink-2 uppercase tracking-[0.04em]">All day</h2>
      {items.length === 0 ? <p className="px-4 text-body text-ink-2">Nothing to make.</p> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto pb-4">
        {items.map((i) => (
          <li key={`${i.product_id}:${i.name}`} className="flex items-baseline justify-between gap-3 px-4 py-1.5">
            <span className="min-w-0 break-words text-line text-ink">{i.name}</span>
            <span className="shrink-0 text-heading text-ink tabular">{i.quantity}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
