import { req } from "@/lib/api";
import { getScope, orSignIn, registerToday, requireApi } from "@/lib/api.server";
import { dateParam, param, reportOutlet, type PageSearchParams } from "@/lib/url-params";
import { ZReportView } from "./ZReportView";

export const metadata = { title: "Z-report" };

export default async function ZReportPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = reportOutlet(outlets.data, scope.outletId, params);
  return <ZReportView outlets={outlets.data} scope={scope} initialOutletId={outletId} today={await registerToday(api, outletId)} initialDate={dateParam(params, "date")} initialStationId={param(params, "station")} />;
}
