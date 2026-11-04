import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

type Search = Promise<{ next?: string; expired?: string }>;

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return "/today";
  return next;
}

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const mode = supabaseUrl && supabaseAnonKey ? ({ kind: "supabase", url: supabaseUrl, anonKey: supabaseAnonKey } as const) : ({ kind: "dev" } as const);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title text-ink">Sign in to the back office</h1>
        <p className="mt-1 text-ink-2">{params.expired ? "Your session ended. Sign in again to continue." : "Use the email on your staff record."}</p>
      </div>
      <LoginForm mode={mode} nextPath={safeNext(params.next)} />
    </div>
  );
}
