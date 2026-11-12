import { PageHeader } from "@sail/ui";
import { createApi, req } from "@/lib/api";
import { API_URL } from "@/lib/api.server";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata = { title: "Change password" };

export default async function ChangePasswordPage() {
  const status = (await req(createApi({ baseUrl: API_URL }).GET("/v1/auth/status"))).data;
  return (
    <>
      <PageHeader title="Change password" description="Your other back-office sessions end; this one stays signed in." />
      {status.provider === "local" ? <ChangePasswordForm /> : <p className="text-ink-2">Your password is managed by your organisation's identity provider.</p>}
    </>
  );
}
