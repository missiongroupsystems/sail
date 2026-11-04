"use client";

import { BrandButton } from "@sail/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { API_URL, ApiError, createGuestApi, createSession, getMenu, getOrder, submitRound, toApiError } from "@/lib/api";
import { createBasketStore, type BasketItem } from "@/lib/basket";
import { brandStyle } from "@/lib/brand";
import { toRoundModifiers } from "@/lib/modifiers";
import { QueryProvider, keys } from "@/lib/query";
import { offendingKey, type SendError } from "@/lib/send-errors";
import { clearSession, deviceId, loadSession, saveSession } from "@/lib/storage";
import { GuestStream, type GuestStreamStatus } from "@/lib/stream";
import type { GuestSession, OrderView, RoundResult } from "@/lib/types";
import { CallStaffSheet } from "./CallStaffSheet";
import { ItemSheet } from "./ItemSheet";
import { MenuView } from "./MenuView";
import { LoadingMenu, Notice } from "./Notices";
import { OurTableView } from "./OurTableView";
import { ReviewView } from "./ReviewView";
import { StatusView } from "./StatusView";

type Phase = { kind: "loading" } | { kind: "invalid" } | { kind: "ended" } | { kind: "unavailable"; error: ApiError } | { kind: "ready" };

/** The screens inside the one page (design 3.3). The URL hash carries them so the phone's back button works. */
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

const RECHECK_MS = 15_000;

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
  const sessionRef = useRef<GuestSession | null>(null);
  sessionRef.current = session;
  const recovered = useRef(false);
  const streamRef = useRef<GuestStream | null>(null);
  const [streamStatus, setStreamStatus] = useState<GuestStreamStatus | null>(null);

  const [view, setView] = useState<View>("menu");
  /** The item sheet stays mounted while it animates closed; `nonce` gives each opening fresh state. */
  const [itemSheet, setItemSheet] = useState<{ productId: string; editKey: string | null; open: boolean; nonce: number } | null>(null);
  const [staffSheet, setStaffSheet] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<SendError | null>(null);
  const clearSendError = useCallback(() => setSendError(null), []);
  const openItem = useCallback((productId: string, editKey: string | null) => setItemSheet((cur) => ({ productId, editKey, open: true, nonce: (cur?.nonce ?? 0) + 1 })), []);
  const closeItem = useCallback(() => setItemSheet((cur) => (cur ? { ...cur, open: false } : null)), []);

  const basketStore = useMemo(() => createBasketStore(token), [token]);
  const basket = useStore(basketStore);

  // One client for the page; the token and the 401 handler are read on each request.
  const onUnauthenticatedRef = useRef<() => void>(() => {});
  const api = useMemo(() => createGuestApi({ getToken: () => sessionRef.current?.guest_token ?? null, onUnauthenticated: () => onUnauthenticatedRef.current() }), []);

  const applySession = useCallback(
    (s: GuestSession) => {
      saveSession(token, s);
      setSession(s);
      setPhase({ kind: "ready" });
    },
    [token],
  );

  /* ---- Session: reuse the stored one, else exchange the QR token (design 4.11 landing). ---- */
  const startSession = useCallback(
    async (force: boolean) => {
      const stored = force ? null : loadSession(token);
      if (stored) {
        applySession(stored);
        return;
      }
      try {
        const s = await createSession(api, { token, device_id: deviceId() });
        applySession(s);
      } catch (e) {
        const err = toApiError(e);
        if (err.isNotFound) setPhase({ kind: "invalid" });
        else setPhase({ kind: "unavailable", error: err });
      }
    },
    [token, api, applySession],
  );

  const onUnauthenticated = useCallback(() => {
    clearSession(token);
    if (!recovered.current) {
      // A stale stored session (the order closed while the tab was away): start a fresh one, once.
      recovered.current = true;
      void startSession(true);
      return;
    }
    setSession(null);
    setPhase({ kind: "ended" });
  }, [token, startSession]);
  onUnauthenticatedRef.current = onUnauthenticated;

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

  /* ---- Menu and order views ---- */
  const menuQuery = useQuery({
    queryKey: keys.menu(session?.channel_link_id ?? ""),
    queryFn: () => getMenu(api, session!.channel_link_id),
    enabled: Boolean(session),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const orderQuery = useQuery({
    queryKey: keys.order(session?.session_id ?? ""),
    queryFn: () => getOrder(api),
    enabled: Boolean(session),
  });
  const menu = menuQuery.data;
  const orderView = orderQuery.data ?? null;

  useEffect(() => {
    if (session && menu) document.title = `Table ${session.table.name} · ${menu.brand.name}`;
  }, [session, menu]);

  /* ---- Brand theming (design 9): tokens on the root element, so sheets rendered in a portal get them too. ---- */
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

  /* ---- Live updates: the stream when an order exists, polling otherwise (design 4.11, 11.3). ---- */
  const sessionId = session?.session_id ?? null;
  useEffect(() => {
    if (!sessionId) return;
    const stream = new GuestStream({
      baseUrl: API_URL,
      getToken: () => sessionRef.current?.guest_token ?? null,
      onChange: () => void queryClient.invalidateQueries({ queryKey: keys.order(sessionId) }),
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
  }, [sessionId, queryClient, onUnauthenticated]);

  /* ---- Not ready to order: re-check every 15 s so the menu opens up when staff seat the table. ---- */
  const canOrder = session?.can_order ?? false;
  useEffect(() => {
    if (!session || canOrder) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), ms);
    };
    const check = async () => {
      try {
        const s = await createSession(api, { token, device_id: deviceId() });
        if (cancelled) return;
        if (s.can_order) {
          applySession(s);
          return;
        }
        schedule(RECHECK_MS);
      } catch (e) {
        if (cancelled) return;
        const err = toApiError(e);
        if (err.isNotFound) {
          setPhase({ kind: "invalid" });
          return;
        }
        // The register limits sessions per device; wait as long as it says, then try again.
        schedule((err.retryAfterSeconds ?? RECHECK_MS / 1000) * 1000);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule(500);
    };
    schedule(RECHECK_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, canOrder, api, token, applySession]);

  /* ---- Sending a round (design 4.11 review → send). ---- */
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
          lines: basket.items.map((i) => ({ line_id: i.key, product_id: i.product_id, quantity: i.quantity, modifiers: toRoundModifiers(i.modifiers), notes: i.notes ?? undefined })),
          ...(name ? { guest_name: name } : {}),
        },
        idempotency_key,
      );
      basketStore.getState().finishSend(round_id);
      const { round_id: _r, status: _s, order_opened: _o, ...viewData } = result;
      queryClient.setQueryData<OrderView>(keys.order(session.session_id), viewData as OrderView);
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
  }, [session, menu, basket.items, basket.guestName, sending, basketStore, api, queryClient, applySession, navigate, menuQuery]);

  /* ---- Screens ---- */
  if (phase.kind === "invalid") return <Notice title="This code isn't valid." body="Ask a member of staff." />;
  if (phase.kind === "ended") return <Notice title="This table session has ended." body="Scan the QR code again." />;
  if (phase.kind === "unavailable") {
    return (
      <Notice title={phase.error.message} body={phase.error.remedy ?? "Please order with a member of staff."}>
        <RetryButton onPress={() => startSession(true)} />
      </Notice>
    );
  }
  if (phase.kind === "loading" || !session) return <LoadingMenu />;
  if (menuQuery.isError && !menu) {
    const err = toApiError(menuQuery.error);
    return (
      <Notice title={err.message} body={err.remedy ?? "Try again in a moment."}>
        <RetryButton onPress={() => menuQuery.refetch()} />
      </Notice>
    );
  }
  if (!menu) return <LoadingMenu />;

  const editing: BasketItem | null = itemSheet?.editKey ? (basket.items.find((i) => i.key === itemSheet.editKey) ?? null) : null;
  const product = itemSheet ? menu.products[itemSheet.productId] : undefined;

  return (
    <div className="min-h-dvh bg-bg text-ink">
      {view === "menu" ? (
        <MenuView
          session={session}
          menu={menu}
          canOrder={canOrder}
          basketItems={basket.items}
          orderView={orderView}
          onOpenItem={(productId) => openItem(productId, null)}
          onReview={() => navigate("review")}
          onCallStaff={() => setStaffSheet(true)}
          onStatus={() => navigate(orderView?.rounds.some((r) => r.mine) ? "status" : "table")}
        />
      ) : null}
      {view === "review" ? (
        <ReviewView
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
          lastRoundId={basket.lastRoundId}
          streamStatus={streamStatus}
          onOrderMore={() => navigate("menu")}
          onCallStaff={() => setStaffSheet(true)}
          onOurTable={() => navigate("table")}
        />
      ) : null}
      {view === "table" ? <OurTableView session={session} orderView={orderView} loading={orderQuery.isPending} onBack={() => navigate(basket.lastRoundId ? "status" : "menu")} onCallStaff={() => setStaffSheet(true)} onOrderMore={() => navigate("menu")} /> : null}

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
      <CallStaffSheet isOpen={staffSheet} onOpenChange={setStaffSheet} api={api} requests={session.service_requests} guestName={basket.guestName} />
    </div>
  );
}

function RetryButton({ onPress }: { onPress: () => void }) {
  return (
    <BrandButton variant="accent" onPress={onPress}>
      Try again
    </BrandButton>
  );
}
