import { PageHeader } from "@sail/ui";
import Link from "next/link";
import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { formatBps, formatLongDate, formatRounding } from "@/lib/format";
import { TodayView } from "./TodayView";

export const metadata = { title: "Today" };

/** Today (design 3.2): what needs a person now at one outlet. Not a KPI dashboard. */
export default async function TodayPage() {
  const api = await requireApi();
  const scope = await getScope();
  const [merchant, outlets] = await orSignIn(Promise.all([req(api.GET("/v1/merchant")), req(api.GET("/v1/outlets"))]));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const s = merchant.data.settings;
  const summary = [
    `GST ${formatBps(s.gst_bps)} ${s.tax_mode === "inclusive" ? "included in prices" : "added at the bill"}`,
    `cash rounding ${formatRounding(s.cash_rounding_increment).toLowerCase()}`,
    `day ends ${s.business_day_cutoff}`,
    s.currency,
  ].join(" · ");

  return (
    <>
      <PageHeader
        eyebrow={formatLongDate()}
        title={merchant.data.name}
        description={
          <>
            {summary}.{" "}
            <Link href="/settings/merchant" className="text-ink underline underline-offset-4">
              Merchant settings
            </Link>
          </>
        }
      />
      <TodayView outlets={outlets.data} scope={scope} initialOutletId={outletId} />
    </>
  );
}
