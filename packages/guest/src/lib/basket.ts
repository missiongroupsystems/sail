import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { uuid } from "./api";
import type { ChosenModifier } from "./modifiers";
import { sessionStorageLike } from "./storage";

export type BasketItem = {
  /** Client id; becomes the line_id the register stores, so a retried send cannot double a line. */
  key: string;
  product_id: string;
  name: string;
  /** Menu price in cents from the register, shown per item; the client never totals it (design principle 8). */
  unit_price: number;
  quantity: number;
  modifiers: ChosenModifier[];
  notes: string | null;
};

export type BasketState = {
  items: BasketItem[];
  /** "So staff know whose order it is" (design 4.11). */
  guestName: string;
  /** The round in flight: the same round_id and Idempotency-Key are reused when a send is retried unchanged. */
  pending: { round_id: string; idempotency_key: string } | null;
  /** The round most recently sent from this phone, for the status page. */
  lastRoundId: string | null;
  add: (item: Omit<BasketItem, "key">) => void;
  update: (key: string, item: Omit<BasketItem, "key">) => void;
  remove: (key: string) => void;
  setGuestName: (name: string) => void;
  /** Start (or resume) a send: a fresh round_id and key the first time, the same ones on a retry of the same basket. */
  beginSend: () => { round_id: string; idempotency_key: string };
  /** The register took the round: empty the basket and remember the round. */
  finishSend: (roundId: string) => void;
};

/** One basket per QR token, kept in sessionStorage so a reload keeps it and a closed tab does not. */
export function createBasketStore(token: string) {
  return createStore<BasketState>()(
    persist(
      (set, get) => ({
        items: [],
        guestName: "",
        pending: null,
        lastRoundId: null,
        add: (item) => set((s) => ({ items: [...s.items, { ...item, key: uuid() }], pending: null })),
        update: (key, item) => set((s) => ({ items: s.items.map((i) => (i.key === key ? { ...item, key } : i)), pending: null })),
        remove: (key) => set((s) => ({ items: s.items.filter((i) => i.key !== key), pending: null })),
        setGuestName: (guestName) => set({ guestName, pending: null }),
        beginSend: () => {
          const cur = get().pending;
          if (cur) return cur;
          const next = { round_id: uuid(), idempotency_key: uuid() };
          set({ pending: next });
          return next;
        },
        finishSend: (roundId) => set({ items: [], pending: null, lastRoundId: roundId }),
      }),
      { name: `sail.guest.basket.${token}`, storage: createJSONStorage(() => sessionStorageLike), version: 1, partialize: (s) => ({ items: s.items, guestName: s.guestName, pending: s.pending, lastRoundId: s.lastRoundId }) as BasketState },
    ),
  );
}

export type BasketStore = ReturnType<typeof createBasketStore>;
