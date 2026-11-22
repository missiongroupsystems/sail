import { makeLocaleFormat, PageHeader } from "@sail/ui";
import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi, scopedOutlets } from "@/lib/api.server";
import { merchantLocale } from "@/lib/locale";
import { TodayView } from "./TodayView";

export const metadata = { title: "Today" };

/** Today: what needs a person now at one outlet. Not a KPI dashboard. */
export default async function TodayPage() {
  const api = await requireApi();
  const scope = await getScope();
  const [merchant, outlets] = await orSignIn(Promise.all([req(api.GET("/v1/merchant")), scopedOutlets().then((data) => ({ data }))]));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const s = merchant.data.settings;
  const { longDate, businessDay } = makeLocaleFormat(merchantLocale(s));
  // The header names the outlet's business day (its cutoff, not the calendar), as every figure on the page does.
  const businessDate = outletId ? await req(api.GET("/v1/outlets/{id}/floor", { params: { path: { id: outletId } } })).then((r) => (r.data as { business_date?: string }).business_date ?? null).catch(() => null) : null;
  return (
    <>
      <PageHeader
        title="Today"
        // The one date on the page. "Business day" stays: after midnight it is the day before the calendar's.
        description={businessDate ? `Business day ${businessDay(businessDate)}` : longDate()}
      />
      <TodayView outlets={outlets.data} scope={scope} initialOutletId={outletId} />
    </>
  );
}
