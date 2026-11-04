import { EmptyState, PageHeader, SectionHeading, StatusDot } from "@sail/ui";
import Link from "next/link";
import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { formatBps, formatLongDate, formatRounding } from "@/lib/format";
import { summariseHours } from "@/lib/hours";

export const metadata = { title: "Today" };

/**
 * Today (design 3.2): what needs a person now. Not a KPI dashboard. Live outlet
 * status, alerts, requests and print health arrive with orders and printing
 * (v0.4, v0.5); until then every tray says so in one line.
 */
export default async function TodayPage() {
  const api = await requireApi();
  const [merchant, outlets] = await orSignIn(Promise.all([req(api.GET("/v1/merchant")), req(api.GET("/v1/outlets"))]));
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

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <SectionHeading title="Outlets" aside={`${outlets.data.length} open`} />
          {outlets.data.length === 0 ? (
            <EmptyState
              variant="quiet"
              title="No outlets yet"
              hint={
                <>
                  Add the first one in{" "}
                  <Link href="/settings/outlets" className="text-ink underline underline-offset-4">
                    Settings
                  </Link>
                  .
                </>
              }
            />
          ) : (
            <ul>
              {outlets.data.map((o) => (
                <li key={o.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 hairline-b">
                  <div className="min-w-0">
                    <p className="text-line text-ink">{o.name}</p>
                    <p className="text-caption text-ink-2">{[o.address, summariseHours(o.hours)].filter(Boolean).join(" · ")}</p>
                  </div>
                  <StatusDot status="neutral" label="No live status yet" muted />
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-col gap-10">
          <section>
            <SectionHeading title="Alerts" />
            <EmptyState variant="quiet" title="Nothing waiting" hint="Print failures and connection problems will appear here." />
          </section>
          <section>
            <SectionHeading title="Requests" />
            <EmptyState variant="quiet" title="Nothing waiting" hint="Manager approvals and assistant requests will appear here." />
          </section>
          <section>
            <SectionHeading title="Print health" />
            <EmptyState variant="quiet" title="Nothing waiting" hint="Printers and relays report here once Printing arrives (v0.5)." />
          </section>
        </div>
      </div>
    </>
  );
}
