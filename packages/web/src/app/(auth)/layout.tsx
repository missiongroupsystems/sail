import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div data-scale="compact" className="flex min-h-dvh flex-col text-body">
      <header className="px-6 py-5">
        <span className="text-heading text-ink">Sail</span>
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-[8vh]">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>
    </div>
  );
}
