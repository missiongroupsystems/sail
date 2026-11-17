import { LinkButton } from "@sail/ui";

export const metadata = { title: "Forgotten your password?" };

/**
 * A forgotten back-office password (A P11). Sail sends no email, so a reset link comes from a person: an Admin of the
 * business, or, when the owner is the only Admin, whoever runs the server (docs/self-hosting.md#sign-in). The page asks
 * for nothing, so it says nothing about which emails have a login.
 */
export default function ForgotPasswordPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-[24px] leading-[1.25] font-semibold tracking-[-0.02em] text-ink">Forgotten your password?</h1>
        <p className="mt-2 text-[14px] leading-5 text-ink-2">This server sends no email, so a reset link comes from a person. It works once, for 24 hours.</p>
      </div>
      <ol className="flex flex-col gap-4 text-[14px] leading-5">
        <li>
          <p className="font-medium text-ink">Ask an Admin of your business</p>
          <p className="mt-1 text-ink-2">In Team, they choose you and make a Password reset link, then send it to you.</p>
        </li>
        <li>
          <p className="font-medium text-ink">If you are the only Admin</p>
          <p className="mt-1 text-ink-2">Whoever runs this server makes the link with one command, given your email:</p>
          <p className="mt-2 rounded-field bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-ink [overflow-wrap:anywhere]">pnpm --filter @sail/server reset-link you@example.com</p>
        </li>
      </ol>
      <LinkButton href="/login" variant="secondary" className="w-full">
        Back to sign in
      </LinkButton>
    </div>
  );
}
