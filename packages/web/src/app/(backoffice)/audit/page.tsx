import { PageHeader } from "@sail/ui";
import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { dateParam, param, type PageSearchParams } from "@/lib/url-params";
import { AuditView } from "./AuditView";

export const metadata = { title: "Changes" };

export default async function AuditPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  const api = await requireApi();
  const [first, staff] = await orSignIn(
    Promise.all([req(api.GET("/v1/audit", { params: { query: { limit: 50 } } })), req(api.GET("/v1/staff", { params: { query: { include_inactive: "true" } } }))]),
  );
  return (
    <>
      <PageHeader title="Changes" />
      <AuditView
        initialPage={first}
        staff={staff.data}
        initial={{ action: param(params, "action"), actor: param(params, "actor"), target: param(params, "target"), from: dateParam(params, "from"), to: dateParam(params, "to") }}
      />
    </>
  );
}
