import { uuid } from "./api";
import type { GuestSession } from "./types";

/**
 * What the phone remembers. The device id lives in localStorage (one per
 * browser, for the register's per-device rate limits); the guest session lives
 * in sessionStorage keyed by the QR token, so a reload keeps it and a closed
 * tab does not. Storage can be unavailable (private mode); everything falls
 * back to memory.
 */
const DEVICE_KEY = "sail.guest.device";
const sessionKey = (token: string) => `sail.guest.session.${token}`;

const memory = new Map<string, string>();

function read(store: Storage | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}
function write(store: Storage | null, key: string, value: string | null) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Private mode or a full store: memory keeps it for this page.
  }
}
const local = () => (typeof window === "undefined" ? null : window.localStorage);
const session = () => (typeof window === "undefined" ? null : window.sessionStorage);

export function deviceId(): string {
  let id = read(local(), DEVICE_KEY);
  if (!id || id.length < 8) {
    id = uuid();
    write(local(), DEVICE_KEY, id);
  }
  return id;
}

/** A stored session that is still at least a minute from expiry, or null. */
export function loadSession(token: string): GuestSession | null {
  const raw = read(session(), sessionKey(token));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as GuestSession;
    if (!s.guest_token || !s.expires_at) return null;
    if (new Date(s.expires_at).getTime() < Date.now() + 60_000) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(token: string, s: GuestSession) {
  write(session(), sessionKey(token), JSON.stringify(s));
}

export function clearSession(token: string) {
  write(session(), sessionKey(token), null);
}

/** sessionStorage for zustand's persist, with the same memory fallback. */
export const sessionStorageLike = {
  getItem: (k: string) => read(session(), k),
  setItem: (k: string, v: string) => write(session(), k, v),
  removeItem: (k: string) => write(session(), k, null),
};
