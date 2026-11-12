import { redirect } from "next/navigation";
import { createApi, req } from "@/lib/api";
import { API_URL } from "@/lib/api.server";
import { LoginForm, type LoginMode } from "./LoginForm";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

type Search = Promise<{ next?: string; expired?: string }>;

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return "/today";
  return next;
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
        <h1 className="text-title text-ink">Sign in to the back office</h1>
        <p className="mt-1 text-ink-2">{params.expired ? "Your session ended. Sign in again to continue." : "Use the email on your staff record."}</p>
      </div>
      <LoginForm mode={mode} nextPath={safeNext(params.next)} />
    </div>
  );
}
