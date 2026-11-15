"use client";

/** The screen dims for the last 10 s before auto-lock; any tap cancels it. */
export function IdleOverlay({ secondsLeft, onTouch }: { secondsLeft: number; onTouch: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={onTouch}
      onClick={onTouch}
      aria-label="Stay signed in"
      className="fixed inset-0 z-[60] flex w-full items-end justify-center bg-[rgba(0,0,0,0.55)] pb-16 text-surface outline-none pos-touch"
    >
      <span className="rounded-tile bg-ink px-5 py-3 text-line text-surface">
        Locking in <span className="tabular">{secondsLeft}</span> s · tap anywhere to stay signed in
      </span>
    </button>
  );
}
