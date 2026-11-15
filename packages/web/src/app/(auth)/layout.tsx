import { SailLogo } from "@sail/ui";
import type { ReactNode } from "react";
import { OfficeSurface } from "@/components/OfficeSurface";

/** Sign-in, first-run setup and invitation links: one white card on the sunken grey, Sail's logo at its top. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div data-scale="compact" className="flex min-h-dvh flex-col bg-bg text-body">
      <OfficeSurface />
      <main className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center sm:px-6 sm:py-16">
        <div className="w-full max-w-[460px] rounded-[16px] border border-rule bg-surface px-6 py-7 sm:px-7">
          <header className="mb-5">
            <SailLogo size="card" />
          </header>
          {children}
        </div>
      </main>
    </div>
  );
}
