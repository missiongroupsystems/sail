export const metadata = { title: "POS" };

/** The `(pos)` route group is reserved for the client-rendered station app (design 11.1). */
export default function PosPlaceholder() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="text-line text-ink-2">The POS arrives in a later phase (v0.4: lock screen, floor plan and order entry).</p>
    </main>
  );
}
