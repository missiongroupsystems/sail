"use client";

import { Button, ConnectionIndicator, cx, deviceLocale, deviceTimeZone, Icon, InlineError, LocaleProvider, Pill, SegmentedControl, useLocale, type ConnectionStatus, type LocaleSettings } from "@sail/ui";
import { AlertTriangle, Ban, Check, ChefHat, Circle, Flame, Pencil, RotateCcw } from "lucide-react";
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

/** Pairing asks the register for a display station, so a POS station's code is refused and its iPad stays paired. */
function Pairing() {
  const setPaired = useDisplayStore((s) => s.setPaired);
  return <PairingScreen device="screen" kind="display" hint="In the back office, open Settings › Stations, choose the kitchen display station and press “Pair a screen”. Enter the 6 digits here." onPaired={(token, station: Station) => setPaired(token, station)} />;
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
      // Tickets keep the order as it was sent, so only ticket events change the board.
      onEvents: (events) => {
        if (events.some((e) => e.type.startsWith("kitchen_ticket."))) refresh();
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
  // "Table 4 bumped" for a few seconds after a bump, so the cook knows the tap landed (Recall in the bar undoes it).
  const [bumped, setBumped] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!bumped) return;
    const t = setTimeout(() => setBumped(null), 4000);
    return () => clearTimeout(t);
  }, [bumped]);
  const act = useMutation<KitchenTicket, ApiError, { id: string; action: "bump" | "recall"; key: string; done?: string }>({
    mutationFn: ({ id, action, key }) => actOnKitchenTicket(api, id, action, { key }),
    onSuccess: (_t, v) => setBumped(v.done ? { text: v.done, at: Date.now() } : null),
    onSettled: settle,
  });
  const pendingId = act.isPending ? act.variables?.id : null;
  const open = tickets.data?.data ?? [];
  const last = tickets.data?.last_bumped ?? null;
  const lateCount = open.filter((t) => t.status !== "cancelled" && (now - new Date(t.fired_at).getTime()) / 1000 >= late * 60).length;

  return (
    <main className="flex h-dvh w-full min-w-0 flex-col bg-bg">
      {/* The kitchen bar: what this screen is, how many tickets, Recall, the theme, the time and the connection. */}
      <header className="flex h-14 shrink-0 items-center gap-x-4 border-b border-rule bg-surface px-5 max-[960px]:gap-x-3 max-[960px]:px-4">
        <h1 className="flex shrink-0 items-center gap-2 font-heading text-[18px] font-semibold text-ink">
          <Icon icon={ChefHat} size={20} />
          Kitchen
        </h1>
        <p className="min-w-0 truncate text-[14px] text-ink-2">{station.name}</p>
        <p className="flex shrink-0 items-center gap-2 text-[14.5px] text-ink">
          <span className="tabular">{open.length === 1 ? "1 ticket" : `${open.length} tickets`}</span>
          {lateCount > 0 ? <Pill tone="alert">{lateCount} late</Pill> : null}
        </p>
        <span className="flex-1" />
        <AriaButton
          isDisabled={!last || act.isPending}
          onPress={() => last && act.mutate({ id: last.id, action: "recall", key: idempotencyKey() })}
          aria-label={last ? `Recall ${ticketTitle(last)}` : "Recall"}
          className="press flex min-h-12 shrink-0 items-center gap-2 rounded-full bg-surface-2 px-5 text-[15px] max-[960px]:px-4 font-medium text-ink outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-3 data-[pressed]:bg-surface-3 data-[disabled]:text-ink-disabled data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
        >
          <Icon icon={RotateCcw} size={18} />
          {/* In portrait the button says Recall alone (its name still names the ticket), so the station's name keeps its room. */}
          <span className="max-w-[220px] truncate max-[960px]:hidden">{last ? `Recall ${ticketTitle(last)}` : "Recall"}</span>
          <span className="hidden max-[960px]:inline">Recall</span>
        </AriaButton>
        <SegmentedControl aria-label="Theme" options={THEMES} selectedId={mode} onSelect={(id) => setMode(id as ThemeMode)} className="shrink-0 p-0.5" />
        <span className="shrink-0 text-[15px] whitespace-nowrap text-ink tabular">{clock(new Date(now))}</span>
        <ConnectionIndicator status={status} />
      </header>
      <div className="flex min-h-0 flex-1">
        <section aria-label="Tickets" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          <InlineError error={tickets.error ?? act.error} className="mb-4" />
          {tickets.data && open.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <Icon icon={ChefHat} size={22} className="text-ink-2" />
              <p className="max-w-[40ch] text-[15px] text-ink-2">No tickets. Items appear here as soon as they are sent to the kitchen.</p>
            </div>
          ) : null}
          {/* As many columns as fit: three on an iPad in landscape, four on a wall screen, two in portrait. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] items-start gap-4 min-[1600px]:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
            {open.map((t) => (
              <TicketCard key={t.id} ticket={t} now={now} warn={warn} late={late} pending={pendingId === t.id} onBump={() => act.mutate({ id: t.id, action: "bump", key: idempotencyKey(), done: `${ticketTitle(t)} ${t.status === "cancelled" ? "cleared" : "bumped"}` })} />
            ))}
          </div>
        </section>
        <AllDay items={allDay.data ?? []} />
      </div>
      {bumped ? (
        <p key={bumped.at} role="status" className="pointer-events-none fixed bottom-5 left-5 z-40 flex items-center gap-3 rounded-sheet bg-(--toast) px-5 py-3.5 text-[15px] text-(--on-toast) shadow-float animate-rise-in">
          <Icon icon={Check} size={18} className="text-status-paid" />
          {bumped.text}
        </p>
      ) : null}
    </main>
  );
}

function ticketTitle(t: KitchenTicket): string {
  if (t.order_type === "dine_in" && t.table_name) return `Table ${t.table_name}`;
  return t.customer_name ? `${t.customer_name} · ${t.order_no}` : t.order_no;
}

const AGE_CHIP = { neutral: "bg-surface-2 text-ink", warn: "bg-status-sent-tint text-status-sent", late: "bg-status-alert text-surface" } as const;

/**
 * A ticket, read from a metre and a half through steam: the table or order in large type, the time it has waited
 * in a chip that turns amber then red, the quantity leading every line. The whole
 * card is the bump target; the Bump pill in its footer is part of it.
 */
function TicketCard({ ticket: t, now, warn, late, pending, onBump }: { ticket: KitchenTicket; now: number; warn: number; late: number; pending: boolean; onBump: () => void }) {
  const seconds = Math.max(0, (now - new Date(t.fired_at).getTime()) / 1000);
  const cancelled = t.status === "cancelled";
  const tone = cancelled ? "neutral" : seconds >= late * 60 ? "late" : seconds >= warn * 60 ? "warn" : "neutral";
  const items = t.lines.reduce((n, l) => n + l.quantity - l.voided_quantity, 0);
  const title = ticketTitle(t);
  const meta = [t.order_type === "dine_in" ? t.order_no : ORDER_TYPE_LABEL[t.order_type as keyof typeof ORDER_TYPE_LABEL], t.pax ? `${t.pax} ${t.pax === 1 ? "guest" : "guests"}` : null, t.server_name, t.round_no > 1 ? `round ${t.round_no}` : null].filter(Boolean).join(" · ");
  const state = cancelled ? { label: "Cancelled", tone: "alert" as const, icon: Ban } : t.status === "recalled" ? { label: "Recalled", tone: "seated" as const, icon: RotateCcw } : t.status === "in_progress" ? { label: "In progress", tone: "sent" as const, icon: Flame } : { label: "New", tone: "seated" as const, icon: Circle };
  return (
    <AriaButton
      onPress={onBump}
      isDisabled={pending}
      aria-label={`${cancelled ? "Clear" : "Bump"} ${title}, ${items} ${items === 1 ? "item" : "items"}${tone === "late" ? ", late" : ""}${t.changed ? ", changed" : ""}${cancelled ? ", cancelled" : ""}`}
      className={cx(
        "press pos-touch relative flex min-w-0 flex-col overflow-hidden rounded-panel border border-rule bg-surface text-left shadow-e1 outline-none",
        "transition-colors duration-[120ms] data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated data-[disabled]:opacity-45",
        t.status === "recalled" && "shadow-e2",
      )}
    >
      <span className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
        <span className="min-w-0">
          <span className={cx("block font-heading text-[22px] leading-tight font-semibold break-words min-[1600px]:text-[26px]", cancelled ? "text-ink-2 line-through" : "text-ink")}>{title}</span>
          {meta ? <span className="mt-1 block text-[13px] text-ink-2 break-words min-[1600px]:text-[15px]">{meta}</span> : null}
        </span>
        <span className={cx("shrink-0 rounded-full px-2.5 py-1 font-heading text-[15px] leading-none font-semibold tabular min-[1600px]:text-[18px]", AGE_CHIP[tone])}>{formatElapsed(seconds)}</span>
      </span>
      {tone === "late" || t.changed ? (
        <span className="flex flex-wrap items-center gap-2 px-4 pb-2.5">
          {tone === "late" ? <Pill tone="alert" icon={AlertTriangle}>Late</Pill> : null}
          {t.changed && !cancelled ? <Pill tone="alert" icon={Pencil}>Changed</Pill> : null}
        </span>
      ) : null}
      <span className="flex flex-1 flex-col gap-2 border-t border-rule px-4 py-3">
        {t.lines.map((l) => (
          <TicketLine key={l.id} line={l} />
        ))}
      </span>
      <span className="flex items-center justify-between gap-2 border-t border-rule px-3 py-2.5">
        <Pill tone={state.tone} icon={state.icon}>
          {state.label}
        </Pill>
        <span aria-hidden className="flex h-11 min-w-[104px] items-center justify-center rounded-full bg-primary px-5 text-[15px] font-semibold text-on-primary">
          {cancelled ? "Clear" : "Bump"}
        </span>
      </span>
    </AriaButton>
  );
}

function TicketLine({ line: l }: { line: KitchenTicketLine }) {
  const left = l.quantity - l.voided_quantity;
  const struck = left <= 0;
  return (
    <span className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 min-[1600px]:grid-cols-[2.25rem_minmax(0,1fr)]">
      <span className={cx("font-heading text-[18px] leading-[1.25] font-semibold tabular min-[1600px]:text-[22px]", struck ? "text-ink-2 line-through" : "text-ink")}>{struck ? l.quantity : left}</span>
      <span className="min-w-0">
        <span className={cx("flex flex-wrap items-baseline gap-x-2 text-[17px] leading-[1.25] font-medium min-[1600px]:text-[21px]", struck ? "text-ink-2" : "text-ink")}>
          <span className={cx("min-w-0 break-words", struck && "line-through")}>{l.name}</span>
          {l.seat_no != null ? <span className="shrink-0 text-[13px] font-medium text-ink-3 tabular">S{l.seat_no}</span> : null}
        </span>
        {l.modifiers.map((m, i) => (
          <span key={i} className={cx("block text-[14.5px] leading-[1.3] text-ink-2 break-words min-[1600px]:text-[17px]", struck && "line-through")}>
            {m}
          </span>
        ))}
        {l.notes ? <span className={cx("block text-[14.5px] leading-[1.3] font-medium italic break-words min-[1600px]:text-[17px]", struck ? "text-ink-2 line-through" : "text-status-sent")}>{l.notes}</span> : null}
        {struck ? <span className="block text-[13px] font-medium text-status-alert">Voided</span> : l.voided_quantity > 0 ? <span className="block text-[13px] font-medium text-status-alert line-through">{l.voided_quantity} voided</span> : null}
      </span>
    </span>
  );
}

function AllDay({ items }: { items: AllDayItem[] }) {
  return (
    <aside aria-label="All day" className="flex w-[240px] shrink-0 flex-col border-l border-rule bg-surface min-[1100px]:w-[280px] min-[1600px]:w-[320px]">
      <h2 className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <span className="font-heading text-[16px] font-semibold text-ink">All day</span>
      </h2>
      {items.length === 0 ? <p className="px-4 text-[15px] text-ink-2">Nothing to make.</p> : null}
      <ul className="min-h-0 flex-1 divide-y divide-rule-subtle overflow-y-auto px-4 pb-4">
        {items.map((i) => (
          <li key={`${i.product_id}:${i.name}`} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="min-w-0 text-[15.5px] text-ink break-words">{i.name}</span>
            <span className="shrink-0 font-heading text-[18px] font-semibold text-ink tabular">{i.quantity}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
