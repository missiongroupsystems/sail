import { getScope, orSignIn, registerToday, requireApi, scopedOutlets } from "@/lib/api.server";
import { dateParam, reportOutlet, type PageSearchParams } from "@/lib/url-params";
import { ItemsView } from "./ItemsView";

export const metadata = { title: "Items" };

export default async function ItemsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(scopedOutlets().then((data) => ({ data })));
  const outletId = reportOutlet(outlets.data, scope.outletId, params);
  return <ItemsView outlets={outlets.data} scope={scope} initialOutletId={outletId} today={await registerToday(api, outletId)} initialRange={{ from: dateParam(params, "from"), to: dateParam(params, "to") }} />;
}
