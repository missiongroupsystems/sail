"use client";

import { createPosApi, type PosApi } from "../api/client";
import { useSessionStore } from "../state/session";
import { useStationStore } from "../state/station";
import { useUiStore } from "../state/ui";

let singleton: PosApi | null = null;

/** Said on the pairing screen when the register ended this iPad's pairing. */
export const NOT_PAIRED = "This iPad is no longer paired to its station. Enter a new code from the back office.";

/** The PIN session token when someone is signed in, otherwise the station token (lock screen, pairing). */
export function currentToken(): string | null {
  return useSessionStore.getState().token ?? useStationStore.getState().token;
}

/** One client per station page. It reads the current token on every request, so switching user needs no rebuild. */
export function posApi(): PosApi {
  if (!singleton) {
    singleton = createPosApi({
      getToken: currentToken,
      onUnauthenticated: (response) => {
        void response
          .json()
          .then((b: { details?: { reason?: string } } | null) => b?.details?.reason ?? null)
          .catch(() => null)
          .then((reason) => {
            // The pairing itself was ended (in the back office, or another iPad paired): straight to pairing, saying so
            // once, rather than "Your session ended" and then a PIN pad that cannot work (final review B-P15).
            if (reason === "station_unpaired") {
              useSessionStore.getState().lock(NOT_PAIRED);
              useUiStore.getState().clearForLock();
              useStationStore.getState().unpair();
              return;
            }
            // A 401 while signed in means the PIN session ended on the register: lock, keep the station paired.
            // The register has already ended it, so there is nothing to end; the PIN pad says why.
            if (useSessionStore.getState().token) {
              useSessionStore.getState().lock("Your session ended. Sign in again.");
              useUiStore.getState().clearForLock();
            }
          });
      },
    });
  }
  return singleton;
}

export function useApi(): PosApi {
  return posApi();
}
