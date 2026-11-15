"use client";

import { zonedInputToIso } from "@sail/shared";
import { Button, DataTable, EmptyState, InlineError, Select, Sheet, TextField, type DataTableColumn, Pill, soldOutText, useLocale, DateField } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { greyPill, SheetSection, TwoLine } from "@/components/office/parts";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { ProductSearch } from "@/components/backoffice/ProductSearch";
import { Warnings } from "@/components/backoffice/Warnings";
import { productName, useProductsById } from "@/components/backoffice/products";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet, Product, StockEntry } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

type Until = "today" | "indefinite" | "at";
type Mode = { kind: "sold_out"; product: Product | null } | { kind: "cap"; product: Product | null } | null;

/** Sold out ("86" is the staff word). Per outlet: what is sold out or capped today, and the actions to change it. */
export function SoldOutView({ outlets, scope, initialOutletId, initialStock }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; initialStock: StockEntry[] }) {
  const { dayClock, timeZone } = useLocale();
  const qc = useQueryClient();
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  // Sold out needs a Cashier and a daily cap a Manager: a role below sees the list without those actions (R new 1).
  const canSoldOut = useCan("stock.mark_sold_out").ok;
  const canCap = useCan("stock.set_daily_cap").ok;
  const [mode, setMode] = useState<Mode>(null);
  const [until, setUntil] = useState<Until>("today");
  const [untilAt, setUntilAt] = useState("");
  const [cap, setCap] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  const stock = useQuery({
    queryKey: keys.stock(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/outlets/{id}/stock", { params: { path: { id: outletId! } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialStock : undefined,
    refetchInterval: 30_000,
  });
  const entries = stock.data ?? [];
  const { byId } = useProductsById(entries.map((e) => e.product_id));

  const settle = async (w: string[]) => {
    await qc.invalidateQueries({ queryKey: keys.stock(outletId ?? "") });
    setWarnings(w);
    if (!w.length) setMode(null);
  };
  const soldOut = useMutation<{ warnings: string[] }, ApiError, { product_id: string; until: string }>({
    mutationFn: (b) => req(api.POST("/v1/stock/sold-out", { body: { outlet_id: outletId!, product_id: b.product_id, until: b.until } })),
    onSuccess: (r) => settle(r.warnings),
  });
  const restore = useMutation<{ warnings: string[] }, ApiError, string>({
    mutationFn: (product_id) => req(api.POST("/v1/stock/restore", { body: { outlet_id: outletId!, product_id } })),
    onSuccess: (r) => settle(r.warnings),
  });
  const dailyCap = useMutation<{ warnings: string[] }, ApiError, { product_id: string; quantity: number | null }>({
    mutationFn: (b) => req(api.POST("/v1/stock/daily-cap", { body: { outlet_id: outletId!, ...b } })),
    onSuccess: (r) => settle(r.warnings),
  });

  useFreshErrors(mode?.kind ?? null, { product: mode?.product?.id ?? null, cap, until, untilAt }, soldOut, dailyCap);
  useFreshErrors(outletId, null, restore);
  const columns: DataTableColumn<StockEntry>[] = useMemo(
    () => [
      { key: "product", header: "Product", isRowHeader: true, width: "2fr", render: (e) => <TwoLine primary={productName(byId, e.product_id)} /> },
      {
        key: "status",
        header: "Status",
        render: (e) => (
          <span className="flex flex-wrap gap-1">
            {e.sold_out ? (
              <Pill size="sm" tone="alert">
                {soldOutText(e, dayClock)}
              </Pill>
            ) : null}
            {e.daily_cap !== null ? (
              <Pill size="sm" tone={e.cap_remaining === 0 ? "alert" : "sent"}>
                Daily cap {e.daily_cap}
                {e.cap_remaining !== null ? ` · ${e.cap_remaining} left` : ""}
              </Pill>
            ) : null}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        align: "end",
        render: (e) => (
          <span className="flex flex-wrap justify-end gap-1">
            {!canSoldOut ? null : e.sold_out ? (
              <Button onPress={() => restore.mutate(e.product_id)} isPending={restore.isPending && restore.variables === e.product_id}>
                Restore
              </Button>
            ) : (
              <Button onPress={() => setMode({ kind: "sold_out", product: byId.get(e.product_id) ?? null })}>Mark sold out</Button>
            )}
            {!canCap ? null : e.daily_cap !== null ? (
              <Button variant="secondary" className={greyPill} onPress={() => dailyCap.mutate({ product_id: e.product_id, quantity: null })}>
                Remove cap
              </Button>
            ) : (
              <Button variant="secondary" className={greyPill} onPress={() => { setCap(""); setMode({ kind: "cap", product: byId.get(e.product_id) ?? null }); }}>
                Set daily cap
              </Button>
            )}
          </span>
        ),
      },
    ],
    [byId, restore, dailyCap, dayClock, canSoldOut, canCap],
  );

  const picked = mode?.product ?? null;
  const untilValue = until === "today" ? "today" : until === "indefinite" ? "indefinite" : untilAt ? (zonedInputToIso(untilAt, timeZone) ?? "") : "";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
        <div className="flex flex-wrap gap-2">
          {canCap ? (
            <Button size="sm" onPress={() => { setCap(""); setMode({ kind: "cap", product: null }); }} isDisabled={!outletId}>
              Set a daily cap
            </Button>
          ) : null}
          {canSoldOut ? (
            <Button size="sm" variant="primary" onPress={() => setMode({ kind: "sold_out", product: null })} isDisabled={!outletId}>
              Mark sold out
            </Button>
          ) : null}
        </div>
      </div>

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="Sold-out items belong to an outlet. Add an outlet first." />
      ) : (
        <DataTable
          aria-label="Sold out and capped items"
          columns={columns}
          rows={entries}
          rowKey={(e) => e.product_id}
          isLoading={stock.isPending}
          emptyState={<EmptyState variant="centred" title="Everything is available" hint={canSoldOut ? "Tap Mark sold out when the kitchen runs out of something." : "Nothing is marked sold out at this outlet."} />}
        />
      )}
      <InlineError error={stock.error ?? restore.error} className="mt-4" />
      <Warnings warnings={warnings} className="mt-4" />

      <Sheet
        isOpen={mode !== null}
        onOpenChange={(open) => !open && setMode(null)}
        title={mode?.kind === "cap" ? "Daily cap" : "Mark sold out"}
        description={mode?.kind === "cap" ? "The item stops selling at this outlet once the quantity is reached today." : "The item shows as sold out on every station and in Scan to order at this outlet."}
        footer={
          <>
            <Button variant="secondary" className={greyPill} onPress={() => setMode(null)}>
              Cancel
            </Button>
            {mode?.kind === "cap" ? (
              <Button variant="primary" isDisabled={!picked || !/^\d+$/.test(cap)} isPending={dailyCap.isPending} onPress={() => picked && dailyCap.mutate({ product_id: picked.id, quantity: Number(cap) })}>
                {picked ? `Cap ${picked.name} at ${cap || "…"} today` : "Set cap"}
              </Button>
            ) : (
              <Button variant="primary" isDisabled={!picked || !untilValue} isPending={soldOut.isPending} onPress={() => picked && soldOut.mutate({ product_id: picked.id, until: untilValue })}>
                {picked ? `Mark ${picked.name} sold out` : "Mark sold out"}
              </Button>
            )}
          </>
        }
      >
        <SheetSection title={mode?.kind === "cap" ? "Cap" : "Sold out"}>
          {picked ? (
            <div className="flex items-center justify-between gap-3 rounded-field bg-surface-2 py-1 pr-1 pl-3">
              <span className="min-w-0 font-medium text-ink [overflow-wrap:anywhere]">{picked.name}</span>
              <Button variant="secondary" onPress={() => setMode(mode ? { ...mode, product: null } : null)}>
                Change
              </Button>
            </div>
          ) : (
            <ProductSearch label="Product" autoFocus onPick={(p) => setMode(mode ? { ...mode, product: p } : null)} />
          )}
          {mode?.kind === "cap" ? (
            <TextField label="Quantity for today" numeric inputMode="numeric" value={cap} onChange={setCap} placeholder="20" className="sm:max-w-[200px]" />
          ) : (
            <>
              <Select
                label="Until"
                selectedKey={until}
                onSelectionChange={(k) => k && setUntil(k as Until)}
                items={[
                  { id: "today", label: "End of today", description: "Comes back at the business day cutoff." },
                  { id: "indefinite", label: "Until restored", description: "Stays sold out until someone restores it." },
                  { id: "at", label: "A time I choose" },
                ]}
              />
              {until === "at" ? <DateField label="Comes back at" type="datetime" size="md" value={untilAt} onChange={setUntilAt} placeholder="Choose a time" className="sm:max-w-[300px]" /> : null}
            </>
          )}
        </SheetSection>
        <InlineError error={soldOut.error ?? dailyCap.error} className="mt-4" />
      </Sheet>
    </>
  );
}
