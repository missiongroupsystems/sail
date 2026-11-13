import { redirect } from "next/navigation";
import { createApi, req } from "@/lib/api";
import { API_URL } from "@/lib/api.server";
import { LoginForm, type LoginMode } from "./LoginForm";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

type Search = Promise<{ next?: string; expired?: string }>;

/**
 * Where to go after signing in: a page of this site only. A browser reads "\" as "/", so "/\example.com" is another
 * site. Anything with a backslash or a control character, or that does not resolve to this origin, goes to Today.
 */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || /[\\\u0000-\u001f]/.test(next)) return "/today";
  const base = "http://sail.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/today";
  }
  if (url.origin !== base || url.pathname.startsWith("/login")) return "/today";
  return `${url.pathname}${url.search}${url.hash}`;
}

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  // The register says how people sign in here, and whether nobody has set it up yet.
  const status = (await req(createApi({ baseUrl: API_URL }).GET("/v1/auth/status"))).data;
  if (status.setup_required) redirect("/setup");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const mode: LoginMode =
    status.provider === "local" ? { kind: "password" } : supabaseUrl && supabaseAnonKey ? { kind: "supabase", url: supabaseUrl, anonKey: supabaseAnonKey } : { kind: "unconfigured" };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-[24px] leading-[1.25] font-semibold tracking-[-0.02em] text-ink">Back office</h1>
        <p className="mt-2 text-[14px] leading-5 text-ink-2">{params.expired ? "Your session ended. Sign in again to continue." : "Use the email on your staff record."}</p>
      </div>
      <LoginForm mode={mode} nextPath={safeNext(params.next)} />
    </div>
  );
}
