import { getScope, orSignIn, requireApi, scopedOutlets } from "@/lib/api.server";
import { dateParam, param, reportOutlet, type PageSearchParams } from "@/lib/url-params";
import { ShiftsView } from "./ShiftsView";

export const metadata = { title: "Shifts" };

export default async function ShiftsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(scopedOutlets().then((data) => ({ data })));
  const outletId = reportOutlet(outlets.data, scope.outletId, params);
  const status = param(params, "status");
  return <ShiftsView outlets={outlets.data} scope={scope} initialOutletId={outletId} initialStatus={status === "open" || status === "closed" ? status : null} initialDate={dateParam(params, "date")} />;
}
