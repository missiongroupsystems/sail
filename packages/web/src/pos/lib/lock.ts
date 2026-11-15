"use client";

import { endSession } from "../api/register";
import type { PosApi } from "../api/client";
import { useSessionStore } from "../state/session";
import { useUiStore } from "../state/ui";

/**
 * Lock the station at once, then end the PIN session on the register with its own token, so a session left behind
 * opens nothing and nothing in the background keeps using it. Every lock goes through here: Lock, Switch user,
 * Sign out and the inactivity timer.
 */
export function lockStation(api: PosApi, note: string | null): Promise<void> {
  const token = useSessionStore.getState().token;
  useSessionStore.getState().lock(note);
  useUiStore.getState().clearForLock();
  if (!token) return Promise.resolve();
  // The register may already have ended it (expired, or ended on another device); the station is locked either way.
  return endSession(api, token).catch(() => undefined);
}
