import type { ReactNode } from "react";

/** A full-page, one-idea notice (empty and error states): a heading, one line of what to do, optional action. */
export function Notice({ title, body, children }: { title: string; body?: ReactNode; children?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col items-start justify-center gap-3 px-4 py-12">
      <h1 className="font-display text-title text-ink">{title}</h1>
      {body ? <p className="text-body text-ink-2">{body}</p> : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </main>
  );
}

/** First load only: a quiet skeleton, never a full-screen spinner. */
export function LoadingMenu() {
  return (
    <main className="mx-auto w-full max-w-[560px] px-4 py-6" aria-busy="true" aria-label="Loading the menu">
      <div className="mb-6 h-7 w-40 animate-skeleton rounded-tile bg-surface-2" />
      <div className="mb-8 flex gap-3">
        {[80, 64, 72].map((w, i) => (
          <div key={i} className="h-10 animate-skeleton rounded-tile bg-surface-2" style={{ width: w }} />
        ))}
      </div>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex flex-col gap-2 py-4 hairline-b">
          <div className="flex justify-between">
            <div className="h-5 w-40 animate-skeleton rounded bg-surface-2" />
            <div className="h-5 w-14 animate-skeleton rounded bg-surface-2" />
          </div>
          <div className="h-4 w-64 animate-skeleton rounded bg-surface-2" />
        </div>
      ))}
    </main>
  );
}
