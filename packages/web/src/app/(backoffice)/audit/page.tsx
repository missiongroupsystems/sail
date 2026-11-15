import { PageHeader } from "@sail/ui";
import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { AuditView } from "./AuditView";

export const metadata = { title: "Audit" };

export default async function AuditPage() {
  const api = await requireApi();
  const [first, staff] = await orSignIn(
    Promise.all([req(api.GET("/v1/audit", { params: { query: { limit: 50 } } })), req(api.GET("/v1/staff", { params: { query: { include_inactive: "true" } } }))]),
  );
  return (
    <>
      <PageHeader title="Audit" description="Who did what, on which target, when, and who approved it." />
      <AuditView initialPage={first} staff={staff.data} />
    </>
  );
}
