import { req } from "@/lib/api";
import { getScope, orSignIn, registerToday, requireApi } from "@/lib/api.server";
import { dateParam, reportOutlet, type PageSearchParams } from "@/lib/url-params";
import { SalesView } from "./SalesView";

export const metadata = { title: "Sales" };

export default async function SalesPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = reportOutlet(outlets.data, scope.outletId, params);
  return <SalesView outlets={outlets.data} scope={scope} initialOutletId={outletId} today={await registerToday(api, outletId)} initialRange={{ from: dateParam(params, "from"), to: dateParam(params, "to") }} />;
}
