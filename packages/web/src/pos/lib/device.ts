"use client";

import { useEffect, useRef, useState } from "react";

/** Screen Wake Lock while signed in; re-acquired when the tab becomes visible again. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Low battery or an unsupported browser: the screen simply follows its own timeout.
      }
    };
    const onVisible = () => {
      if (!cancelled && document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [active]);
}

/**
 * Inactivity watch: `warning` is true for the last 10 s before
 * `timeoutSeconds` of no touches; `onTimeout` fires once. Any pointer or key
 * event resets it.
 */
export function useIdleLock(active: boolean, timeoutSeconds: number, onTimeout: () => void): { warning: boolean; secondsLeft: number; touch: () => void } {
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(timeoutSeconds);
  const last = useRef(Date.now());
  const fired = useRef(false);
  const cb = useRef(onTimeout);
  cb.current = onTimeout;

  // The effect must not depend on `warning`: re-running it would reset `last` and the countdown would never reach zero.
  useEffect(() => {
    if (!active) return;
    last.current = Date.now();
    fired.current = false;
    setWarning(false);
    let throttle = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - throttle < 500) return;
      throttle = now;
      last.current = now;
      setWarning(false);
    };
    const events: (keyof DocumentEventMap)[] = ["pointerdown", "keydown", "touchstart", "wheel"];
    for (const e of events) document.addEventListener(e, onActivity, { passive: true, capture: true });
    const tick = setInterval(() => {
      const idle = (Date.now() - last.current) / 1000;
      const left = Math.max(0, Math.ceil(timeoutSeconds - idle));
      setSecondsLeft(left);
      setWarning(left <= 10 && left > 0);
      if (left <= 0 && !fired.current) {
        fired.current = true;
        cb.current();
      }
    }, 1000);
    return () => {
      clearInterval(tick);
      for (const e of events) document.removeEventListener(e, onActivity, { capture: true } as EventListenerOptions);
    };
  }, [active, timeoutSeconds]);

  return { warning, secondsLeft, touch: () => (last.current = Date.now()) };
}

/** A ticking clock for elapsed times and the lock-screen clock. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
