"use client";

import { Badge, Button, QuantityStepper, SearchField, Sheet, Skeleton, TextField, useLocale } from "@sail/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { toApiError } from "@/lib/api";
import { markSoldOut, restoreStock, setDailyCap } from "../../api/register";
import type { CompiledProduct, StockEntry } from "../../api/types";
import { usePos } from "../../components/PosContext";
import { posKeys, useStock } from "../../hooks/queries";
import { useApi } from "../../hooks/useApi";
import { roleAtLeast } from "../../hooks/useOrderActions";
import { searchMenu } from "../../lib/menu";
import { todayAt } from "../../lib/format";
import { useUiStore } from "../../state/ui";

/** Sold-out list (design 4.12): search or browse, tap the item, then Today / Until… / Indefinitely; Restore; a daily cap for Managers. */
export function SoldOutView() {
  const { clock } = useLocale();
  const api = useApi();
  const qc = useQueryClient();
  const { station, menu, staff, offline } = usePos();
  const notify = useUiStore((s) => s.notify);
  const stock = useStock(station.outlet_id);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<CompiledProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState("");
  const [cap, setCap] = useState(10);
  const canCap = roleAtLeast(staff.role, "manager");
  const canMark = roleAtLeast(staff.role, "cashier");

  const entries = useMemo(() => new Map((stock.data ?? []).map((e) => [e.product_id, e])), [stock.data]);
  const results = useMemo(() => (menu && query.trim() ? searchMenu(menu, query).slice(0, 40) : []), [menu, query]);
  const affected = useMemo(() => (stock.data ?? []).filter((e) => e.sold_out || e.daily_cap != null).map((e) => ({ e, p: menu?.products[e.product_id] })).filter((x) => x.p), [stock.data, menu]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: posKeys.stock(station.outlet_id) });
    void qc.invalidateQueries({ queryKey: ["pos", "menu"] });
  };
  const run = async (label: string, fn: () => Promise<StockEntry>) => {
    setBusy(true);
    try {
      await fn();
      notify({ text: label, tone: "success" }, 4000);
      refresh();
      setPicked(null);
      setUntil("");
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    } finally {
      setBusy(false);
    }
  };

  const entry = picked ? entries.get(picked.id) : undefined;
  const untilIso = until ? todayAt(until) : null;

  const row = (p: CompiledProduct, e: StockEntry | undefined) => (
    <li key={p.id}>
      <AriaButton onPress={() => setPicked(p)} className="press pos-touch flex min-h-14 w-full items-center justify-between gap-3 rounded-tile px-4 text-left outline-none data-[pressed]:bg-surface-2 data-[hovered]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-status-seated">
        <span className="min-w-0">
          <span className="block truncate text-line text-ink">{p.name}</span>
          <span className="block truncate text-caption text-ink-2">{p.sku ? `${p.sku} · ` : ""}{e?.sold_out ? (e.sold_out_until ? `Sold out until ${clock(e.sold_out_until)}` : "Sold out") : p.unavailable_reason ?? "Available"}{e?.daily_cap != null ? ` · cap ${e.daily_cap}${e.cap_remaining != null ? ` (${e.cap_remaining} left)` : ""}` : ""}</span>
        </span>
        {e?.sold_out ? <Badge tone="alert">Sold out</Badge> : e?.daily_cap != null ? <Badge tone="sent">Capped</Badge> : null}
      </AriaButton>
    </li>
  );

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="text-title text-ink">Sold out</h1>
        <p className="text-body text-ink-2">Search the menu, tap an item, then say for how long. Tiles update on every station.</p>
      </div>
      <SearchField value={query} onChange={setQuery} placeholder="Search the menu" label="Search the menu" />
      {query.trim() ? (
        <section>
          <h2 className="mb-2 text-caption text-ink-2 uppercase tracking-[0.04em]">Results</h2>
          {results.length === 0 ? <p className="text-body text-ink-2">Nothing on this menu matches "{query}".</p> : <ul className="flex flex-col gap-1">{results.map((p) => row(p, entries.get(p.id)))}</ul>}
        </section>
      ) : null}
      <section>
        <h2 className="mb-2 text-caption text-ink-2 uppercase tracking-[0.04em]">Sold out or capped now</h2>
        {stock.isLoading && !stock.data ? <Skeleton lines={3} /> : affected.length === 0 ? <p className="text-body text-ink-2">Nothing is sold out at this outlet.</p> : <ul className="flex flex-col gap-1">{affected.map(({ e, p }) => row(p!, e))}</ul>}
      </section>

      <Sheet isOpen={Boolean(picked)} onOpenChange={(o) => (!o ? setPicked(null) : undefined)} title={picked?.name ?? ""} description={entry?.sold_out ? (entry.sold_out_until ? `Sold out until ${clock(entry.sold_out_until)}` : "Sold out") : "Available now"} isDismissable={!busy}>
        {picked ? (
          <div className="flex flex-col gap-6">
            {!canMark ? <p className="text-body text-ink-2">Marking items sold out needs a Cashier or above.</p> : null}
            <section className="flex flex-col gap-2">
              <h3 className="text-line text-ink">Sold out</h3>
              <Button size="lg" isDisabled={offline || busy || !canMark} onPress={() => void run(`${picked.name} sold out for today`, () => markSoldOut(api, station.outlet_id, picked.id, "today"))} className="justify-start">
                Today
              </Button>
              <div className="flex items-end gap-2">
                <TextField label="Until (HH:MM)" value={until} onChange={setUntil} placeholder="18:30" inputClassName="min-h-14 text-line tabular" className="w-[160px]" isInvalid={Boolean(until && !untilIso)} errorMessage={until && !untilIso ? "Use HH:MM" : undefined} />
                <Button size="lg" isDisabled={offline || busy || !canMark || !untilIso} onPress={() => untilIso && void run(`${picked.name} sold out until ${until}`, () => markSoldOut(api, station.outlet_id, picked.id, untilIso))}>
                  Until {until || "…"}
                </Button>
              </div>
              <Button size="lg" isDisabled={offline || busy || !canMark} onPress={() => void run(`${picked.name} sold out until restored`, () => markSoldOut(api, station.outlet_id, picked.id, "indefinite"))} className="justify-start">
                Indefinitely
              </Button>
              {entry?.sold_out ? (
                <Button size="lg" variant="primary" isDisabled={offline || busy || !canMark} onPress={() => void run(`${picked.name} is back`, () => restoreStock(api, station.outlet_id, picked.id))}>
                  Restore {picked.name}
                </Button>
              ) : null}
            </section>
            <section className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2 text-line text-ink">
                Daily cap {!canCap ? <Badge tone="bill">Manager</Badge> : null}
              </h3>
              <p className="text-body text-ink-2">{entry?.daily_cap != null ? `Capped at ${entry.daily_cap} a day · ${entry.cap_remaining ?? 0} left today.` : "No cap. Tiles show the count when 5 or fewer are left."}</p>
              <div className="flex items-center gap-3">
                <QuantityStepper value={cap} onChange={setCap} min={1} max={999} label="Daily cap" />
                <Button size="lg" isDisabled={offline || busy || !canCap} onPress={() => void run(`${picked.name} capped at ${cap} a day`, () => setDailyCap(api, station.outlet_id, picked.id, cap))}>
                  Set cap {cap}
                </Button>
                {entry?.daily_cap != null ? (
                  <Button size="lg" variant="quiet" isDisabled={offline || busy || !canCap} onPress={() => void run(`Cap removed from ${picked.name}`, () => setDailyCap(api, station.outlet_id, picked.id, null))}>
                    Remove cap
                  </Button>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
