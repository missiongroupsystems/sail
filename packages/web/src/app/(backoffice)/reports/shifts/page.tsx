import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { dateParam, param, reportOutlet, type PageSearchParams } from "@/lib/url-params";
import { ShiftsView } from "./ShiftsView";

export const metadata = { title: "Shifts" };

export default async function ShiftsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = reportOutlet(outlets.data, scope.outletId, params);
  const status = param(params, "status");
  return <ShiftsView outlets={outlets.data} scope={scope} initialOutletId={outletId} initialStatus={status === "open" || status === "closed" ? status : null} initialDate={dateParam(params, "date")} />;
}
