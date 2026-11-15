import { redirect } from "next/navigation";
import { createApi, req } from "@/lib/api";
import { API_URL } from "@/lib/api.server";
import { SetupForm } from "./SetupForm";

export const metadata = { title: "Set up Sail" };
export const dynamic = "force-dynamic";

/** First-run setup: only while the register has no merchant. */
export default async function SetupPage() {
  const status = (await req(createApi({ baseUrl: API_URL }).GET("/v1/auth/status"))).data;
  if (!status.setup_required) redirect("/login");
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-[24px] leading-[1.25] font-semibold tracking-[-0.02em] text-ink">Set up Sail</h1>
        <p className="mt-2 text-[14px] leading-5 text-ink-2">Your business, its first outlet and the first Admin. You can change all of it later in Settings.</p>
      </div>
      <SetupForm withPassword={status.provider === "local"} />
    </div>
  );
}
