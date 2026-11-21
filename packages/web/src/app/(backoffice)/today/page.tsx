import { makeLocaleFormat, PageHeader } from "@sail/ui";
import Link from "next/link";
import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi, scopedOutlets } from "@/lib/api.server";
import { formatRounding } from "@/lib/format";
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
  const { money, longDate, businessDay } = makeLocaleFormat(merchantLocale(s));
  // The header names the outlet's business day (its cutoff, not the calendar), as every figure on the page does.
  const businessDate = outletId ? await req(api.GET("/v1/outlets/{id}/floor", { params: { path: { id: outletId } } })).then((r) => (r.data as { business_date?: string }).business_date ?? null).catch(() => null) : null;
  const summary = [
    s.tax_mode === "inclusive" ? "tax included in prices" : "tax added at the bill",
    `cash rounding ${s.cash_rounding_increment ? formatRounding(s.cash_rounding_increment, money) : "off"}`,
    `day ends ${s.business_day_cutoff}`,
    s.currency,
  ].join(" · ");

  return (
    <>
      <PageHeader
        title="Today"
        eyebrow={merchant.data.name}
        description={
          <>
            {businessDate ? `Business day ${businessDay(businessDate)}` : longDate()} · {summary}.{" "}
            <Link href="/settings/merchant" className="whitespace-nowrap text-ink underline underline-offset-4 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
              Merchant settings
            </Link>
          </>
        }
      />
      <TodayView outlets={outlets.data} scope={scope} initialOutletId={outletId} />
    </>
  );
}
