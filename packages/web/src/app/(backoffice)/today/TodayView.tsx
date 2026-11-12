"use client";

import { Badge, Button, Dialog, EmptyState, InlineError, Money, SectionHeading, Stat, StatusDot, taxRows, TextField, useLocale } from "@sail/ui";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { label, ORDER_TYPE_LABEL } from "@/components/backoffice/labels";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { isLate, JobRowActions, RerouteDialog, useJobMutations } from "@/components/backoffice/PrintJobActions";
import { boKeys, can, formatElapsed, plural, REQUEST_TYPE_LABEL, type FloorSnapshot, type GuestRound, type PrintJob, type ServiceRequest, type Shift, type ZReport } from "@/components/backoffice/register";
import { RelayStatus } from "@/components/backoffice/RelayPairingPanel";
import { Warnings } from "@/components/backoffice/Warnings";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useSession } from "@/lib/session-context";
import { orderJobs } from "../printing/jobs/PrintJobsView";

const POLL = 15_000;

/**
 * Today: what needs a person now, for one outlet. Trays first; the
 * day's figures last and quiet. Everything polls the register every 15 s.
 */
export function TodayView({ outlets, scope, initialOutletId }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null }) {
  const { clock, dayClock, isoDate } = useLocale();
  const { me, merchant } = useSession();
  const qc = useQueryClient();
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const canDecide = can(me, "rounds.accept");
  const canAck = can(me, "service_requests.acknowledge");
  const [note, setNote] = useState<{ text: string; warnings: string[] } | null>(null);
  const [rejecting, setRejecting] = useState<GuestRound | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rerouteLate, setRerouteLate] = useState(false);

  const enabled = outletId !== null;
  const id = outletId ?? "";
  const [floor, rounds, requests, late, relays, shifts, z] = useQueries({
    queries: [
      { queryKey: boKeys.floor(id), queryFn: () => req(api.GET("/v1/outlets/{id}/floor", { params: { path: { id } } })).then((r) => r.data as unknown as FloorSnapshot), enabled, refetchInterval: POLL },
      { queryKey: boKeys.rounds(id), queryFn: () => req(api.GET("/v1/outlets/{id}/rounds", { params: { path: { id }, query: { status: "pending" } } })).then((r) => r.data as unknown as GuestRound[]), enabled, refetchInterval: POLL },
      { queryKey: boKeys.serviceRequests(id), queryFn: () => req(api.GET("/v1/outlets/{id}/service-requests", { params: { path: { id }, query: { status: "open" } } })).then((r) => r.data as unknown as ServiceRequest[]), enabled, refetchInterval: POLL },
      { queryKey: boKeys.printJobs(id, { late: "true" }), queryFn: () => req(api.GET("/v1/outlets/{id}/print-jobs", { params: { path: { id }, query: { late: "true", limit: 100 } } })).then((r) => r.data), enabled, refetchInterval: POLL },
      { queryKey: boKeys.relays(id), queryFn: () => req(api.GET("/v1/relays", { params: { query: { outlet_id: id } } })).then((r) => r.data), enabled, refetchInterval: POLL },
      { queryKey: boKeys.shifts(id, { status: "open" }), queryFn: () => req(api.GET("/v1/outlets/{id}/shifts", { params: { path: { id }, query: { status: "open" } } })).then((r) => r.data as unknown as Shift[]), enabled, refetchInterval: POLL },
      { queryKey: boKeys.zReport(id, isoDate(), null), queryFn: () => req(api.GET("/v1/outlets/{id}/z-report", { params: { path: { id }, query: { business_date: isoDate() } } })).then((r) => r.data as unknown as ZReport), enabled, refetchInterval: POLL },
    ],
  });
  const printers = useQuery({
    queryKey: boKeys.printers(id),
    queryFn: () => req(api.GET("/v1/printers", { params: { query: { outlet_id: id, include_archived: "true" } } })).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });

  const lateJobs = useMemo(() => orderJobs((late.data ?? []).filter(isLate)), [late.data]);
  const offline = (relays.data ?? []).filter((r) => !r.archived && r.paired && !r.online);
  const unpaired = (relays.data ?? []).filter((r) => !r.archived && !r.paired);
  const seated = (floor.data?.tables ?? []).filter((t) => t.status !== "free");
  const onDone = (text: string, warnings: string[]) => setNote({ text, warnings });
  const { reroute } = useJobMutations(onDone);

  const refreshTrays = () => Promise.all([qc.invalidateQueries({ queryKey: boKeys.rounds(id) }), qc.invalidateQueries({ queryKey: boKeys.serviceRequests(id) }), qc.invalidateQueries({ queryKey: boKeys.floor(id) }), qc.invalidateQueries({ queryKey: ["print-jobs"] })]);
  const accept = useMutation<{ warnings: string[] }, ApiError, GuestRound>({
    mutationFn: (r) => req(api.POST("/v1/rounds/{id}/accept", { params: { path: { id: r.id } }, body: {} })),
    onSuccess: async (res, r) => {
      await refreshTrays();
      setNote({ text: `Accepted the QR order for ${r.table_name ?? "the table"}; the kitchen tickets are queued.`, warnings: res.warnings });
    },
  });
  const reject = useMutation<{ warnings: string[] }, ApiError, { round: GuestRound; reason: string }>({
    mutationFn: ({ round, reason }) => req(api.POST("/v1/rounds/{id}/reject", { params: { path: { id: round.id } }, body: { reason } })),
    onSuccess: async (res, { round }) => {
      await refreshTrays();
      setRejecting(null);
      setNote({ text: `Rejected the QR order for ${round.table_name ?? "the table"}. The guest sees the reason.`, warnings: res.warnings });
    },
  });
  const acknowledge = useMutation<{ warnings: string[] }, ApiError, ServiceRequest>({
    mutationFn: (r) => req(api.POST("/v1/service-requests/{id}/acknowledge", { params: { path: { id: r.id } }, body: {} })),
    onSuccess: refreshTrays,
  });

  const outlet = outlets.find((o) => o.id === outletId) ?? null;
  const firstError = floor.error ?? rounds.error ?? requests.error ?? late.error ?? relays.error ?? shifts.error ?? z.error;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
        {floor.data ? (
          <p className="text-caption text-ink-2 tabular">
            As of {clock(floor.data.as_of)} · refreshes every 15 s
          </p>
        ) : null}
      </div>

      {outlets.length === 0 ? (
        <EmptyState
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
      ) : null}
      <InlineError error={firstError as ApiError | null} className="mb-4" />
      {note ? (
        <div className="mb-6 flex flex-col gap-2" role="status">
          <p className="text-body text-ink">{note.text}</p>
          <Warnings warnings={note.warnings} />
        </div>
      ) : null}

      {outlet ? (
        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-10">
            <section>
              <SectionHeading title="Service" aside={floor.data ? `${plural(floor.data.open_orders, "open order")} · ${seated.length} of ${floor.data.tables.length} tables seated` : "loading"} />
              {floor.data ? (
                seated.length === 0 && floor.data.other_orders.length === 0 ? (
                  <EmptyState variant="quiet" title="No open orders" hint="Tables and takeaway orders appear here as stations open them." />
                ) : (
                  <ul className="flex flex-col">
                    {seated
                      .slice()
                      .sort((a, b) => (b.requests_waiting - a.requests_waiting) || ((b.order?.pending_rounds ?? 0) - (a.order?.pending_rounds ?? 0)) || ((b.order?.elapsed_seconds ?? 0) - (a.order?.elapsed_seconds ?? 0)))
                      .map((t) => (
                        <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 hairline-b">
                          <span className="inline-flex flex-wrap items-baseline gap-2">
                            <span className="text-line text-ink">{t.name}</span>
                            <StatusDot status={t.status === "bill_requested" ? "bill" : t.status === "sent" ? "sent" : t.status === "paid" ? "paid" : "seated"} label={t.status === "bill_requested" ? "Bill requested" : t.status === "sent" ? "Sent" : t.status === "paid" ? "Paid" : "Seated"} muted />
                            {t.order?.pax ? <span className="text-caption text-ink-2">{t.order.pax} pax</span> : null}
                            {t.order?.pending_rounds ? <Badge tone="bill">{plural(t.order.pending_rounds, "QR round")} waiting</Badge> : null}
                            {t.requests_waiting ? <Badge tone="alert">{plural(t.requests_waiting, "request")}</Badge> : null}
                          </span>
                          <span className="tabular text-ink-2">
                            {t.order ? <><span className="font-mono text-caption">{t.order.order_no}</span> · {formatElapsed(t.order.elapsed_seconds)} · </> : null}
                            {t.order ? <Money cents={t.order.total} /> : null}
                          </span>
                        </li>
                      ))}
                    {floor.data.other_orders.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 hairline-b">
                        <span className="inline-flex flex-wrap items-baseline gap-2">
                          <span className="text-line text-ink">{label(ORDER_TYPE_LABEL, o.order_type)}</span>
                          <span className="text-ink-2">{o.customer_ref?.name || o.customer_ref?.mobile || ""}</span>
                          {o.ready_by ? <span className="text-caption text-ink-2">ready by {clock(o.ready_by)}</span> : null}
                        </span>
                        <span className="tabular text-ink-2">
                          <span className="font-mono text-caption">{o.order_no}</span> · <Money cents={o.total} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
              <p className="mt-2 text-caption text-ink-2">
                <Link href="/orders" className="text-ink underline underline-offset-4">
                  Open Orders
                </Link>{" "}
                for the detail drawer.
              </p>
            </section>

            <section>
              <SectionHeading title="QR orders waiting" aside={rounds.data ? `${rounds.data.length}` : "loading"} />
              {rounds.data && rounds.data.length === 0 ? <EmptyState variant="quiet" title="Nothing waiting" hint="Rounds guests submit from their phones land here until a person accepts them." /> : null}
              <ul className="flex flex-col">
                {(rounds.data ?? []).map((r) => (
                  <li key={r.id} className="flex flex-col gap-1 py-3 hairline-b">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="inline-flex flex-wrap items-baseline gap-2">
                        <span className="text-line text-ink">{r.table_name ?? "Table"}</span>
                        {r.guest_name ? <span className="text-ink-2">{r.guest_name}</span> : null}
                        <span className="text-caption text-ink-2 tabular">submitted {clock(r.submitted_at)} · waiting {formatElapsed((Date.now() - new Date(r.submitted_at).getTime()) / 1000)}</span>
                      </span>
                      {canDecide ? (
                        <span className="inline-flex gap-1">
                          <Button variant="quiet" className="min-h-9 px-2.5 text-caption text-status-alert" onPress={() => { setRejectReason(""); setRejecting(r); }}>
                            Reject…
                          </Button>
                          <Button variant="primary" className="min-h-9 px-3 text-caption" onPress={() => accept.mutate(r)} isPending={accept.isPending && accept.variables?.id === r.id}>
                            Accept
                          </Button>
                        </span>
                      ) : null}
                    </div>
                    <p className="text-caption text-ink-2">
                      {r.lines.map((l) => `${l.quantity}× ${l.name}${l.modifiers.length ? ` (${l.modifiers.join(", ")})` : ""}`).join(" · ")}
                      {r.notes ? ` · “${r.notes}”` : ""}
                    </p>
                  </li>
                ))}
              </ul>
              <InlineError error={accept.error} className="mt-2" />
            </section>

            <section>
              <SectionHeading title="Table requests" aside={requests.data ? `${requests.data.length}` : "loading"} />
              {requests.data && requests.data.length === 0 ? <EmptyState variant="quiet" title="Nothing waiting" hint="Call-staff and bill requests from guests' phones land here." /> : null}
              <ul className="flex flex-col">
                {(requests.data ?? []).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 hairline-b">
                    <span className="inline-flex flex-wrap items-baseline gap-2">
                      <span className="text-line text-ink">{r.table_name ?? "Table"}</span>
                      <Badge tone="bill">{label(REQUEST_TYPE_LABEL, r.type)}</Badge>
                      {r.guest_name ? <span className="text-ink-2">{r.guest_name}</span> : null}
                      <span className="text-caption text-ink-2 tabular">{clock(r.created_at)} · waiting {formatElapsed((Date.now() - new Date(r.created_at).getTime()) / 1000)}</span>
                    </span>
                    {canAck ? (
                      <Button variant="quiet" className="min-h-9 px-2.5 text-caption" onPress={() => acknowledge.mutate(r)} isPending={acknowledge.isPending && acknowledge.variables?.id === r.id}>
                        Acknowledge
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <InlineError error={acknowledge.error} className="mt-2" />
            </section>
          </div>

          <div className="flex flex-col gap-10">
            <section>
              <SectionHeading
                title="Tickets not printed"
                aside={
                  lateJobs.length > 1 ? (
                    <Button variant="quiet" className="min-h-9 px-2.5 text-caption" onPress={() => setRerouteLate(true)}>
                      Reroute all {lateJobs.length}
                    </Button>
                  ) : late.data ? (
                    `${lateJobs.length}`
                  ) : (
                    "loading"
                  )
                }
              />
              {late.data && lateJobs.length === 0 ? <EmptyState variant="quiet" title="Nothing waiting" hint="Every ticket printed within 10 seconds." /> : null}
              <ul className="flex flex-col">
                {lateJobs.map((j: PrintJob) => (
                  <li key={j.id} className="flex flex-col gap-1 py-2 hairline-b">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span className="text-ink">
                        {(printers.data ?? []).find((p) => p.id === j.printer_id)?.name ?? "Printer"}
                        <span className="text-caption text-ink-2"> · {label({ kitchen: "kitchen ticket", void: "void ticket", reprint: "reprint", test: "test print", receipt: "receipt", refund_receipt: "refund receipt", prebill: "pre-bill" }, j.kind)}</span>
                      </span>
                      <span className="tabular text-status-alert">{formatElapsed(j.age_seconds)}</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-x-4">
                      <span className="text-caption text-ink-2">
                        {j.attempts ? `${plural(j.attempts, "attempt")}` : "not yet attempted"}
                        {j.last_error ? ` · ${j.last_error}` : ""}
                      </span>
                      <JobRowActions job={j} printers={printers.data ?? []} onDone={onDone} compact />
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <SectionHeading title="Relays" aside={relays.data ? `${relays.data.filter((r) => !r.archived).length}` : "loading"} />
              {relays.data && relays.data.filter((r) => !r.archived).length === 0 ? (
                <EmptyState
                  variant="quiet"
                  title="No relay at this outlet"
                  hint={
                    <>
                      Nothing will print until one is paired in{" "}
                      <Link href="/printing/relays" className="text-ink underline underline-offset-4">
                        Printing
                      </Link>
                      .
                    </>
                  }
                />
              ) : null}
              {relays.data && offline.length === 0 && unpaired.length === 0 && relays.data.filter((r) => !r.archived).length > 0 ? <EmptyState variant="quiet" title="Nothing waiting" hint={`${plural(relays.data.filter((r) => !r.archived).length, "relay")} online.`} /> : null}
              <ul className="flex flex-col">
                {[...offline, ...unpaired].map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 hairline-b">
                    <span className="inline-flex flex-wrap items-baseline gap-2">
                      <span className="text-line text-ink">{r.name}</span>
                      <RelayStatus relay={r} />
                    </span>
                    <span className="text-caption text-ink-2 tabular">{r.last_seen_at ? `last seen ${dayClock(r.last_seen_at)}` : "never seen"}</span>
                  </li>
                ))}
              </ul>
              {offline.length ? <p className="mt-2 text-caption text-ink-2">Check the print box is powered and on the network. Tickets stay queued until it returns.</p> : null}
            </section>

            <section>
              <SectionHeading title="Open shifts" aside={shifts.data ? `${shifts.data.length}` : "loading"} />
              {shifts.data && shifts.data.length === 0 ? <EmptyState variant="quiet" title="No open shift" hint="Stations open a shift with a counted float." /> : null}
              <ul className="flex flex-col">
                {(shifts.data ?? []).map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 hairline-b">
                    <span className="inline-flex flex-wrap items-baseline gap-2">
                      <span className="text-line text-ink">{s.name ?? (s.station_id ? "Station shift" : "Outlet shift")}</span>
                      <span className="text-caption text-ink-2">{s.opened_by ? `${s.opened_by} · ` : ""}since {clock(s.opened_at)}</span>
                    </span>
                    <span className="tabular text-ink-2">
                      float <Money cents={s.float_cents} />
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-caption text-ink-2">
                <Link href="/reports/shifts" className="text-ink underline underline-offset-4">
                  Shifts
                </Link>{" "}
                has the closed ones with expected, counted and variance.
              </p>
            </section>

            <section>
              <SectionHeading title="Today so far" aside={z.data ? `business day ${z.data.scope.business_date}` : "loading"} />
              {z.data ? (
                <div className="flex flex-col gap-4 pt-3">
                  <div className="flex flex-wrap gap-x-10 gap-y-4">
                    <Stat label="Net sales" value={<Money cents={z.data.sales.net} size="heading" />} hint={`${plural(z.data.orders.count, "completed order")}`} />
                    <Stat label="Covers" value={z.data.orders.covers} hint={z.data.orders.open_count ? `${z.data.orders.open_count} still open` : undefined} />
                    {[...taxRows(z.data.sales.taxes, merchant.settings.tax_mode).before, ...taxRows(z.data.sales.taxes, merchant.settings.tax_mode).after].map((t) => (
                      <Stat key={t.key} label={t.label} value={<Money cents={t.amount} size="heading" />} />
                    ))}
                    {z.data.refunds.count ? <Stat label="Refunds" value={<Money cents={z.data.refunds.amount} size="heading" />} hint={plural(z.data.refunds.count, "refund")} /> : null}
                  </div>
                  <ul className="flex flex-wrap gap-x-10 gap-y-3">
                    {z.data.tenders.map((t) => (
                      <li key={t.tender_type_id} className="flex flex-col">
                        <span className="text-caption text-ink-2">{t.tender}</span>
                        <span className="tabular text-ink">
                          <Money cents={t.amount} /> <span className="text-caption text-ink-2">· {t.count}</span>
                        </span>
                      </li>
                    ))}
                    {z.data.tenders.length === 0 ? <li className="text-caption text-ink-2">No payments yet.</li> : null}
                  </ul>
                  <p className="text-caption text-ink-2">
                    Register figures.{" "}
                    <Link href="/reports/z-report" className="text-ink underline underline-offset-4">
                      Full Z-report
                    </Link>
                  </p>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      ) : null}

      <Dialog
        isOpen={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={rejecting ? `Reject the QR order for ${rejecting.table_name ?? "the table"}` : "Reject"}
        footer={
          <>
            <Button variant="quiet" onPress={() => setRejecting(null)} isDisabled={reject.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" isDisabled={!rejectReason.trim()} isPending={reject.isPending} onPress={() => rejecting && reject.mutate({ round: rejecting, reason: rejectReason.trim() })}>
              Reject order
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pt-2">
          <p>The guest sees the reason on their phone. The items are removed and daily caps released.</p>
          <TextField label="Reason" value={rejectReason} onChange={setRejectReason} placeholder="Kitchen is closing" autoFocus />
          <InlineError error={reject.error} />
        </div>
      </Dialog>

      {rerouteLate ? (
        <RerouteDialog
          jobs={lateJobs}
          printers={printers.data ?? []}
          isOpen
          onClose={() => {
            setRerouteLate(false);
            reroute.reset();
          }}
          onReroute={(target) => reroute.mutate({ jobIds: lateJobs.map((j) => j.id), printerId: target }, { onSuccess: () => setRerouteLate(false) })}
          isPending={reroute.isPending}
          error={reroute.error}
        />
      ) : null}
    </>
  );
}
