"use client";

import { BrandButton, LocaleProvider } from "@sail/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, CheckCheck, Clock, QrCode } from "lucide-react";
import { useStore } from "zustand";
import { API_URL, ApiError, createGuestApi, createSession, getMenu, getOrder, sessionLive, submitRound, toApiError } from "@/lib/api";
import { createBasketStore, type BasketItem } from "@/lib/basket";
import { brandStyle } from "@/lib/brand";
import { QueryProvider, keys } from "@/lib/query";
import { offendingKey, type SendError } from "@/lib/send-errors";
import { showsPayPrompt } from "@/lib/status";
import { clearSession, deviceId, loadSession, saveSession } from "@/lib/storage";
import { GuestStream, type GuestStreamStatus } from "@/lib/stream";
import type { CompiledMenu, GuestSession, OrderView, RoundResult } from "@/lib/types";
import { CallStaffSheet } from "./CallStaffSheet";
import { ItemSheet } from "./ItemSheet";
import { MenuView } from "./MenuView";
import { LoadingMenu, Notice } from "./Notices";
import { OurTableView } from "./OurTableView";
import { ReviewView } from "./ReviewView";
import { roundLines, useQuote } from "./useQuote";
import { StatusView } from "./StatusView";

/** `held`: on the paid screen, the session that ended with the payment, kept in case the order is open again (review 4 U4). */
type Phase = { kind: "loading" } | { kind: "invalid" } | { kind: "ended"; paid?: boolean; cancelled?: boolean; held?: GuestSession } | { kind: "rotated" } | { kind: "unavailable"; error: ApiError } | { kind: "ready" };

/** The screens inside the one page. The URL hash carries them so the phone's back button works. */
export type View = "menu" | "review" | "status" | "table";
function viewFromHash(hash: string): View {
  switch (hash) {
    case "#review":
      return "review";
    case "#status":
      return "status";
    case "#table":
      return "table";
    default:
      return "menu";
  }
}

/**
 * While the table is not ready, the only way to learn it was seated is a new
 * session (the register has no cheaper check), and sessions are limited per
 * device. Re-check at 15 s, backing off to a minute, and at once when the
 * phone comes back to the page.
 */
const RECHECK_MS = 15_000;
const RECHECK_MAX_MS = 60_000;
/** On the paid screen: how soon, and at most how far apart, the phone asks whether the order is open again. */
const PAID_RECHECK_MS = 4_000;
const PAID_RECHECK_MAX_MS = 30_000;

export function GuestApp({ token }: { token: string }) {
  return (
    <QueryProvider>
      <GuestAppInner token={token} />
    </QueryProvider>
  );
}

function GuestAppInner({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [session, setSession] = useState<GuestSession | null>(null);
  const [requestSent, setRequestSent] = useState<string | null>(null);
  useEffect(() => {
    if (!requestSent) return;
    const t = setTimeout(() => setRequestSent(null), 6000);
    return () => clearTimeout(t);
  }, [requestSent]);
  const sessionRef = useRef<GuestSession | null>(null);
  sessionRef.current = session;
  // The café and table this phone was at, kept after its session ends so the notice can name them.
  const placeRef = useRef<string | null>(null);
  if (session) placeRef.current = `${session.outlet.name} · Table ${session.table.name}`;
  /** The session came from sessionStorage and has not yet been confirmed by the register. */
  const restored = useRef(false);
  /** The session id whose 401 has already been handled; concurrent requests all fail together. */
  const endedSession = useRef<string | null>(null);
  const streamRef = useRef<GuestStream | null>(null);
  const [streamStatus, setStreamStatus] = useState<GuestStreamStatus | null>(null);

  const [view, setView] = useState<View>("menu");
  /** The item sheet stays mounted while it animates closed; `nonce` gives each opening fresh state. */
  const [itemSheet, setItemSheet] = useState<{ productId: string; editKey: string | null; open: boolean; nonce: number } | null>(null);
  const [staffSheet, setStaffSheet] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<SendError | null>(null);
  const clearSendError = useCallback(() => setSendError(null), []);
  // "Could not reach the restaurant" is about the connection: once the phone is back online it goes, and Send is there to
  // try again (final2 C Low: it stayed after the connection returned).
  useEffect(() => {
    const back = () => setSendError((e) => (e?.error.code === "unavailable" ? null : e));
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, []);
  const openItem = useCallback((productId: string, editKey: string | null) => setItemSheet((cur) => ({ productId, editKey, open: true, nonce: (cur?.nonce ?? 0) + 1 })), []);
  const closeItem = useCallback(() => setItemSheet((cur) => (cur ? { ...cur, open: false } : null)), []);

  const basketStore = useMemo(() => createBasketStore(token), [token]);
  const basket = useStore(basketStore);
  const basketLines = useMemo(() => roundLines(basket.items), [basket.items]);

  // One client for the page; the token and the 401 handler are read on each request.
  const onUnauthenticatedRef = useRef<(details?: Record<string, unknown>) => void>(() => {});
  const api = useMemo(() => createGuestApi({ getToken: () => sessionRef.current?.guest_token ?? null, onUnauthenticated: (e) => onUnauthenticatedRef.current(e.details) }), []);

  // The register's price for the basket, for the cart bar and the review (final review C-6).
  // Not while the menu already says something in the basket is gone: the review flags it and Send waits, and the register
  // would only refuse the quote.
  const menuNow = queryClient.getQueryData<CompiledMenu>(keys.menu(session?.channel_link_id ?? ""));
  const basketGone = basket.items.some((i) => {
    const p = menuNow?.products[i.product_id];
    return !p || p.sold_out || !p.available_now;
  });
  const basketQuote = useQuote(api, session?.session_id ?? "", basketLines, Boolean(session && menuNow) && !basketGone);

  const applySession = useCallback(
    (s: GuestSession) => {
      saveSession(token, s);
      setSession(s);
      setPhase({ kind: "ready" });
    },
    [token],
  );

  /* ---- Session: reuse the stored one, else exchange the QR token. ---- */
  const startSession = useCallback(
    async (force: boolean) => {
      const stored = force ? null : loadSession(token);
      if (stored) {
        restored.current = true;
        applySession(stored);
        return;
      }
      setPhase({ kind: "loading" });
      try {
        const s = await createSession(api, { token, device_id: deviceId() });
        restored.current = false;
        applySession(s);
      } catch (e) {
        const err = toApiError(e);
        // A code of the wrong length is refused by the register's validator: to a guest it is simply not a valid code (D-5).
        if (err.details?.reason === "code_rotated") setPhase({ kind: "rotated" });
        else if (err.isNotFound || err.code === "validation") setPhase({ kind: "invalid" });
        else setPhase({ kind: "unavailable", error: err });
      }
    },
    [token, api, applySession],
  );

  /**
   * The register rejected the guest token: the order closed or the 4-hour
   * session ran out. A session restored from storage may simply be stale (the
   * table was paid while the tab was away), so that one is exchanged again
   * quietly; a session that was live on this page ends with a clear notice.
   */
  const onUnauthenticated = useCallback((details?: Record<string, unknown>) => {
    const rotated = details?.reason === "code_rotated";
    const current = sessionRef.current?.session_id ?? "";
    if (endedSession.current === current) return;
    endedSession.current = current;
    // Paid: one screen, live or after a reload, and the session is kept: when staff void the payment or reopen the order,
    // the phone is back on it with its own rounds.
    if (details?.reason === "order_paid" && sessionRef.current) {
      const held = sessionRef.current;
      restored.current = false;
      setSession(null);
      setPhase({ kind: "ended", paid: true, held });
      return;
    }
    clearSession(token);
    if (restored.current && !rotated) {
      restored.current = false;
      void startSession(true);
      return;
    }
    setSession(null);
    setPhase(rotated ? { kind: "rotated" } : { kind: "ended", paid: details?.reason === "order_paid", cancelled: details?.reason === "order_cancelled" });
  }, [token, startSession]);
  onUnauthenticatedRef.current = onUnauthenticated;

  /* ---- Paid: the register is asked now and then whether the order is open again (a voided payment, a reopen). ---- */
  const held = phase.kind === "ended" ? (phase.held ?? null) : null;
  useEffect(() => {
    if (!held) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = PAID_RECHECK_MS;
    const check = async () => {
      if (stopped || new Date(held.expires_at).getTime() < Date.now()) return;
      if (document.visibilityState === "hidden") return schedule();
      const answer = await sessionLive(held.guest_token);
      if (stopped) return;
      if (answer === "live") {
        // Back on the open order, the same session and so the same rounds.
        endedSession.current = null;
        void queryClient.invalidateQueries({ queryKey: keys.order(held.session_id) });
        applySession(held);
        return;
      }
      if (answer && answer.reason !== "order_paid") {
        clearSession(token);
        setPhase(answer.reason === "code_rotated" ? { kind: "rotated" } : { kind: "ended", cancelled: answer.reason === "order_cancelled" });
        return;
      }
      delay = Math.min(delay * 2, PAID_RECHECK_MAX_MS);
      schedule();
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), delay);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      delay = PAID_RECHECK_MS;
      if (timer) clearTimeout(timer);
      void check();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [held, token, applySession, queryClient]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in development; one session is enough.
    started.current = true;
    void startSession(false);
  }, [startSession]);

  /* ---- Hash routing ---- */
  useEffect(() => {
    const sync = () => setView(viewFromHash(window.location.hash));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const navigate = useCallback((v: View) => {
    const hash = v === "menu" ? "" : `#${v}`;
    if (window.location.hash === hash || (v === "menu" && !window.location.hash)) {
      setView(v);
      return;
    }
    if (v === "menu") window.history.pushState(null, "", window.location.pathname + window.location.search);
    else window.location.hash = hash;
    setView(v);
    window.scrollTo({ top: 0 });
  }, []);
  /**
   * "Order again" and "Start again" after a session ended: a new session that opens on the menu, with no sheet left open
   * and nothing of the last session's screen (live-test final2 C-5). The hash is replaced, not pushed, so Back does not
   * return to the ended session's status page.
   */
  const startAgain = useCallback(() => {
    clearSession(token);
    setItemSheet(null);
    setStaffSheet(false);
    setSendError(null);
    setRequestSent(null);
    basketStore.setState({ lastRoundId: null });
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setView("menu");
    window.scrollTo({ top: 0 });
    void startSession(true);
  }, [basketStore, startSession, token]);
  // The screens swap inside one page, so move focus to the new screen's heading for VoiceOver.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    document.querySelector<HTMLElement>("h1[tabindex]")?.focus({ preventScroll: true });
  }, [view]);

  /* ---- Menu and order views ---- */
  const menuQuery = useQuery({
    queryKey: keys.menu(session?.channel_link_id ?? ""),
    queryFn: () => getMenu(api, session!.channel_link_id),
    enabled: Boolean(session),
    // Sold out and availability change during service: an open menu catches up within half a minute, and at once
    // when the phone comes back to the page (live-test D-7, E-L19).
    staleTime: 20_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const orderQuery = useQuery({
    queryKey: keys.order(session?.session_id ?? ""),
    queryFn: () => getOrder(api),
    enabled: Boolean(session),
    // No order on the table yet: the stream would only answer 409 (logged in the console, live-test D-14), so poll.
    refetchInterval: (q) => (q.state.data?.order ? false : RECHECK_MS),
  });
  const menu = menuQuery.data;
  const orderView = orderQuery.data ?? null;
  const orderError = orderQuery.isError ? toApiError(orderQuery.error) : null;
  // The register answered with this token: a later 401 means the order closed, not a stale store.
  const orderConfirmed = orderQuery.isSuccess;
  useEffect(() => {
    if (orderConfirmed) restored.current = false;
  }, [orderConfirmed]);

  useEffect(() => {
    if (session && menu) document.title = `Table ${session.table.name} · ${menu.brand.name}`;
  }, [session, menu]);

  /* ---- Brand theming: tokens on the root element, so sheets rendered in a portal get them too. ---- */
  const brandId = menu?.brand.id ?? null;
  const brandAccent = menu?.brand.accent_color ?? null;
  const brandFont = menu?.brand.display_font ?? null;
  useEffect(() => {
    if (!brandId) return;
    const root = document.documentElement;
    const style = brandStyle({ accent_color: brandAccent, display_font: brandFont }) as Record<string, string>;
    root.dataset.brand = brandId;
    for (const [k, v] of Object.entries(style)) root.style.setProperty(k, v);
    return () => {
      delete root.dataset.brand;
      for (const k of Object.keys(style)) root.style.removeProperty(k);
    };
  }, [brandId, brandAccent, brandFont]);

  /* ---- Live updates: the stream when an order exists, polling otherwise. ---- */
  const sessionId = session?.session_id ?? null;
  const hasOrder = Boolean(orderQuery.data?.order);
  useEffect(() => {
    if (!sessionId || !hasOrder) return;
    const stream = new GuestStream({
      baseUrl: API_URL,
      getToken: () => sessionRef.current?.guest_token ?? null,
      onChange: () => void queryClient.invalidateQueries({ queryKey: keys.order(sessionId) }),
      onStock: () => void queryClient.invalidateQueries({ queryKey: keys.menu(sessionRef.current?.channel_link_id ?? "") }),
      onStatus: setStreamStatus,
      onUnauthenticated,
      pollMs: RECHECK_MS,
    });
    streamRef.current = stream;
    stream.start();
    return () => {
      stream.stop();
      streamRef.current = null;
    };
  }, [sessionId, hasOrder, queryClient, onUnauthenticated]);

  /* ---- Not ready to order: re-check so the menu opens up when staff seat the table. ---- */
  const canOrder = session?.can_order ?? false;
  /** "Check again" on the not-ready banner: the next check now, instead of at the back-off's next step. */
  const checkNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!session || canOrder) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = RECHECK_MS;
    let checking = false;
    let waitUntil = 0;
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), ms);
    };
    const check = async () => {
      // A phone in a pocket spends no sessions; the visibility handler checks as soon as it is back.
      if (document.visibilityState === "hidden") {
        schedule(delay);
        return;
      }
      checking = true;
      try {
        const s = await createSession(api, { token, device_id: deviceId() });
        if (cancelled) return;
        if (s.can_order) {
          restored.current = false;
          applySession(s);
          return;
        }
        delay = Math.min(delay * 2, RECHECK_MAX_MS);
        schedule(delay);
      } catch (e) {
        if (cancelled) return;
        const err = toApiError(e);
        if (err.isNotFound) {
          setPhase({ kind: err.details?.reason === "code_rotated" ? "rotated" : "invalid" });
          return;
        }
        // The register limits sessions per device; wait as long as it says, then try again.
        const wait = (err.retryAfterSeconds ?? delay / 1000) * 1000;
        waitUntil = Date.now() + wait;
        schedule(wait);
      } finally {
        checking = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      delay = RECHECK_MS;
      schedule(500);
    };
    schedule(RECHECK_MS);
    checkNow.current = () => {
      // One check at a time, and never inside the register's back-off: repeated taps would spend the device's sessions.
      if (checking || Date.now() < waitUntil) return;
      delay = RECHECK_MS;
      schedule(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      checkNow.current = null;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, canOrder, api, token, applySession]);

  /* ---- Sending a round (review → send). ---- */
  const send = useCallback(async () => {
    if (!session || !menu || basket.items.length === 0 || sending) return;
    setSending(true);
    setSendError(null);
    const { round_id, idempotency_key } = basketStore.getState().beginSend();
    const name = basket.guestName.trim();
    try {
      const result: RoundResult = await submitRound(
        api,
        {
          round_id,
          lines: basketLines,
          ...(name ? { guest_name: name } : {}),
        },
        idempotency_key,
      );
      basketStore.getState().finishSend(round_id);
      const { round_id: _r, status: _s, order_opened: _o, ...viewData } = result;
      // A read already on the wire left before the round existed: it must not replace this answer with a view that has
      // no round from this phone ("No orders have been sent from this phone yet" for a few seconds, review 4 U4).
      await queryClient.cancelQueries({ queryKey: keys.order(session.session_id) });
      queryClient.setQueryData<OrderView>(keys.order(session.session_id), viewData as OrderView);
      restored.current = false; // the register has accepted this session
      if (!session.order_open) applySession({ ...session, order_open: true, can_order: true });
      streamRef.current?.kick();
      navigate("status");
    } catch (e) {
      const err = toApiError(e);
      if (err.tableNotOpen) {
        applySession({ ...session, can_order: false, order_open: false });
        setSendError({ kind: "table_not_open", error: err });
      } else if (err.isRateLimited) {
        setSendError({ kind: "rate_limited", error: err, retryIn: err.retryAfterSeconds ?? 10 });
      } else if (err.status === 400 && err.groupId) {
        setSendError({ kind: "group", error: err, groupId: err.groupId });
      } else if (err.code === "unavailable" && err.productId) {
        setSendError({ kind: "product", error: err, productId: err.productId });
        void menuQuery.refetch();
      } else {
        setSendError({ kind: "general", error: err });
      }
    } finally {
      setSending(false);
    }
  }, [session, menu, basket.items, basketLines, basket.guestName, sending, basketStore, api, queryClient, applySession, navigate, menuQuery]);

  /* ---- Screens ---- */
  if (phase.kind === "invalid") return <Notice icon={QrCode} tone="warning" title="This code isn't valid." body="Ask a member of staff." />;
  if (phase.kind === "rotated") return <Notice place={placeRef.current} icon={QrCode} title="This table has a new QR code." body="Scan the code on the table again to keep ordering." />;
  if (phase.kind === "ended" && phase.paid) {
    // Ended because the table's bill was paid: a thank-you, not a timeout.
    return (
      <Notice place={placeRef.current} icon={CheckCheck} title="Your bill is paid." body="Thank you for coming. To order again, scan the QR code on the table.">
        {/* The same action as Start again on the other ended screens, at the same weight (review 3, S8). */}
        <BrandButton variant="accent" onPress={startAgain}>
          Order again
        </BrandButton>
      </Notice>
    );
  }
  if (phase.kind === "ended" && phase.cancelled) {
    // Ended because staff cancelled the order (and turned down any round still waiting): say so, not a timeout.
    return (
      <Notice place={placeRef.current} icon={Ban} title="The restaurant cancelled this order." body="Anything still waiting was not sent to the kitchen. Ask a member of staff, or start again here.">
        <BrandButton variant="accent" onPress={startAgain}>
          Start again
        </BrandButton>
      </Notice>
    );
  }
  if (phase.kind === "ended") {
    return (
      <Notice place={placeRef.current} icon={Clock} title="This table session has ended." body="Scan the QR code on the table again, or start again here.">
        <BrandButton variant="accent" onPress={startAgain}>
          Start again
        </BrandButton>
      </Notice>
    );
  }
  if (phase.kind === "unavailable") {
    return (
      <Notice icon={AlertTriangle} title={phase.error.message} body={phase.error.remedy ?? "Please order with a member of staff."}>
        <RetryButton onPress={() => startSession(true)} />
      </Notice>
    );
  }
  if (phase.kind === "loading" || !session) return <LoadingMenu />;
  if (menuQuery.isError && !menu && toApiError(menuQuery.error).status !== 401) {
    const err = toApiError(menuQuery.error);
    return (
      <Notice place={placeRef.current} icon={AlertTriangle} title={err.message} body={err.remedy ?? "Try again in a moment."}>
        <RetryButton onPress={() => menuQuery.refetch()} />
      </Notice>
    );
  }
  if (!menu) return <LoadingMenu />;

  const editing: BasketItem | null = itemSheet?.editKey ? (basket.items.find((i) => i.key === itemSheet.editKey) ?? null) : null;
  const product = itemSheet ? menu.products[itemSheet.productId] : undefined;

  return (
    <LocaleProvider settings={{ currency: session.settings.currency, currencyExponent: session.settings.currency_exponent, locale: session.settings.locale, timeZone: session.settings.timezone }}>
      <div className="min-h-dvh bg-surface text-ink">
        {view === "menu" ? (
          <MenuView
            session={session}
            menu={menu}
            canOrder={canOrder}
            onCheckAgain={() => checkNow.current?.()}
            basketItems={basket.items}
            basketQuote={basketQuote}
            orderView={orderView}
            onOpenItem={(productId) => openItem(productId, null)}
            onReview={() => navigate("review")}
            onCallStaff={() => setStaffSheet(true)}
            onStatus={() => navigate(orderView?.rounds.some((r) => r.mine) ? "status" : "table")}
            onOurTable={() => navigate("table")}
          />
        ) : null}
        {view === "review" ? (
          <ReviewView
            tax={orderView?.tax ?? null}
            quote={basketQuote}
            session={session}
            menu={menu}
            items={basket.items}
            guestName={basket.guestName}
            onGuestName={basket.setGuestName}
            canOrder={canOrder}
            sending={sending}
            error={sendError}
            onEdit={(key) => {
              const item = basket.items.find((i) => i.key === key);
              if (item) openItem(item.product_id, key);
            }}
            onRemove={(key) => {
              basket.remove(key);
              setSendError(null);
            }}
            onQuantity={(key, quantity) => {
              const item = basket.items.find((i) => i.key === key);
              if (item) basket.update(key, { ...item, quantity });
            }}
            onSend={() => void send()}
            onBack={() => navigate("menu")}
            onClearError={clearSendError}
          />
        ) : null}
        {view === "status" ? (
          <StatusView
            session={session}
            orderView={orderView}
            loading={orderQuery.isPending}
            error={orderError}
            lastRoundId={basket.lastRoundId}
            streamStatus={streamStatus}
            onOrderMore={() => navigate("menu")}
            onCallStaff={() => setStaffSheet(true)}
            onOurTable={() => navigate("table")}
          />
        ) : null}
        {view === "table" ? <OurTableView session={session} orderView={orderView} loading={orderQuery.isPending} error={orderError} onBack={() => navigate(basket.lastRoundId ? "status" : "menu")} onCallStaff={() => setStaffSheet(true)} onOrderMore={() => navigate("menu")} /> : null}

        {product && itemSheet ? (
          <ItemSheet
            key={`${itemSheet.productId}:${itemSheet.editKey ?? "new"}:${itemSheet.nonce}`}
            isOpen={itemSheet.open}
            onOpenChange={(open) => {
              if (!open) closeItem();
            }}
            menu={menu}
            product={product}
            editing={editing}
            api={api}
            sessionId={session.session_id}
            groupError={sendError?.kind === "group" && editing && offendingKey(sendError, basket.items, menu) === editing.key ? sendError.error.message : null}
            onAdd={(item) => {
              basket.add(item);
              closeItem();
            }}
            onUpdate={(key, item) => {
              basket.update(key, item);
              setSendError(null);
              closeItem();
            }}
          />
        ) : null}
        <CallStaffSheet isOpen={staffSheet} onOpenChange={setStaffSheet} api={api} requests={session.service_requests} guestName={basket.guestName} onSent={setRequestSent} payPrompt={showsPayPrompt(orderView)} />
        {/* After the sheet closes, the page still says the request went (it confirmed under its row while open). */}
        {requestSent && !staffSheet ? (
          <p role="status" className="fixed inset-x-4 bottom-24 z-40 mx-auto max-w-[480px] rounded-panel bg-(--toast) px-4 py-3 text-[15px] font-medium text-(--on-toast) shadow-float">
            {requestSent}: sent. Someone will be with you shortly.
          </p>
        ) : null}
      </div>
    </LocaleProvider>
  );
}

function RetryButton({ onPress }: { onPress: () => void }) {
  return (
    <BrandButton variant="accent" onPress={onPress}>
      Try again
    </BrandButton>
  );
}
