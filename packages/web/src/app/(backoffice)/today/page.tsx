import { makeLocaleFormat, PageHeader } from "@sail/ui";
import Link from "next/link";
import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { formatRounding } from "@/lib/format";
import { merchantLocale } from "@/lib/locale";
import { TodayView } from "./TodayView";

export const metadata = { title: "Today" };

/** Today: what needs a person now at one outlet. Not a KPI dashboard. */
export default async function TodayPage() {
  const api = await requireApi();
  const scope = await getScope();
  const [merchant, outlets] = await orSignIn(Promise.all([req(api.GET("/v1/merchant")), req(api.GET("/v1/outlets"))]));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const s = merchant.data.settings;
  const { money, longDate } = makeLocaleFormat(merchantLocale(s));
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
            {longDate()} · {summary}.{" "}
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
