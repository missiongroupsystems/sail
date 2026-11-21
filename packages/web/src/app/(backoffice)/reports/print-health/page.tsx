import { getScope, orSignIn, registerToday, requireApi, scopedOutlets } from "@/lib/api.server";
import { dateParam, reportOutlet, type PageSearchParams } from "@/lib/url-params";
import { PrintHealthView } from "./PrintHealthView";

export const metadata = { title: "Print health" };

export default async function PrintHealthPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(scopedOutlets().then((data) => ({ data })));
  const outletId = reportOutlet(outlets.data, scope.outletId, params);
  return <PrintHealthView outlets={outlets.data} scope={scope} initialOutletId={outletId} today={await registerToday(api, outletId)} initialRange={{ from: dateParam(params, "from"), to: dateParam(params, "to") }} />;
}
