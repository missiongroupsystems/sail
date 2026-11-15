"use client";

import { Button, InlineError, Money, MoneyField, PercentField, Select, Sheet, useLocale, FieldsLocked } from "@sail/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { greyPill, Group, SheetSection } from "@/components/office/parts";
import { Warnings } from "@/components/backoffice/Warnings";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Product } from "@/lib/api/types";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

type Mode = "set" | "add" | "percent";

/** Integer cents in, integer cents out; a change that would go below zero stops at zero. */
function newPrice(current: number, mode: Mode, amount: number | null, bps: number | null): number {
  if (mode === "set") return Math.max(0, amount ?? current);
  if (mode === "add") return Math.max(0, current + (amount ?? 0));
  const delta = Math.round((current * (bps ?? 0)) / 10_000);
  return Math.max(0, current + delta);
}

/** Select rows, set prices, one call to /v1/products/bulk-price. Per-order-type prices move with the base price. */
export function BulkPriceSheet({ isOpen, products, onClose, onSaved }: { isOpen: boolean; products: Product[]; onClose: () => void; onSaved: () => void }) {
  const { moneyText } = useLocale();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("set");
  const [amount, setAmount] = useState<number | null>(null);
  const [bps, setBps] = useState<number | null>(null);
  const [alsoByOrderType, setAlsoByOrderType] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);

  const changes = useMemo(
    () =>
      products.map((p) => {
        const price = newPrice(p.price, mode, amount, bps);
        const by: Record<string, number> = {};
        if (alsoByOrderType && mode !== "set") {
          for (const [k, v] of Object.entries(p.prices_by_order_type)) if (typeof v === "number") by[k] = newPrice(v, mode, amount, bps);
        }
        return { product: p, price, prices_by_order_type: alsoByOrderType && mode !== "set" ? by : undefined };
      }),
    [products, mode, amount, bps, alsoByOrderType],
  );

  const save = useMutation<{ data: { updated: number }; warnings: string[] }, ApiError>({
    mutationFn: () =>
      req(
        api.POST("/v1/products/bulk-price", {
          body: {
            changes: changes.map((c) => ({ product_id: c.product.id, price: c.price, ...(c.prices_by_order_type && Object.keys(c.prices_by_order_type).length ? { prices_by_order_type: c.prices_by_order_type } : {}) })),
          },
        }),
      ),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["products"] });
      if (res.warnings.length) setWarnings(res.warnings);
      else onSaved();
    },
  });

  const ready = mode === "set" ? amount !== null : mode === "add" ? amount !== null && amount !== 0 : bps !== null && bps !== 0;

  const mayEdit = useCan("products.bulk_price");
  useFreshErrors(isOpen, { mode, amount, bps, alsoByOrderType }, save);
  return (
    <FieldsLocked locked={!mayEdit.ok}>
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!save.isPending}
      width="lg"
      title={`Set prices for ${products.length} ${products.length === 1 ? "product" : "products"}`}
      description="One change for every selected product. Nothing is saved until you tap the button below."
      footer={
        <>
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => save.mutate()} isPending={save.isPending} isDisabled={!mayEdit.ok || !ready}>
            Save {products.length} {products.length === 1 ? "price" : "prices"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-7">
        <SheetSection title="Change">
        <div className="grid gap-4 sm:grid-cols-[220px_200px]">
          <Select
            label="Change"
            selectedKey={mode}
            onSelectionChange={(k) => k && setMode(k as Mode)}
            items={[
              { id: "set", label: "Set base price to" },
              { id: "add", label: "Add or subtract an amount", description: "Use a minus sign to reduce." },
              { id: "percent", label: "Change by a percentage", description: "Rounded to the nearest cent." },
            ]}
          />
          {mode === "percent" ? (
            <PercentField label="Percentage" value={bps} onChange={setBps} placeholder="10" description="Negative values are not supported; use an amount to reduce." />
          ) : (
            <MoneyField label={mode === "set" ? "New base price" : "Amount"} value={amount} onChange={setAmount} placeholder={mode === "set" ? undefined : moneyText(50)} />
          )}
        </div>
        {mode !== "set" ? (
          <Select
            label="Per-order-type prices"
            selectedKey={alsoByOrderType ? "yes" : "no"}
            onSelectionChange={(k) => setAlsoByOrderType(k === "yes")}
            items={[
              { id: "yes", label: "Change them by the same amount" },
              { id: "no", label: "Leave them as they are" },
            ]}
            className="sm:max-w-[320px]"
          />
        ) : null}
        </SheetSection>

        <SheetSection flat title="Preview">
        <Group className="overflow-hidden">
        <table className="w-full text-[14px] leading-5">
          <thead>
            <tr className="text-left text-[12.5px] text-ink-3">
              <th className="border-b border-rule-subtle px-4 py-2 font-medium">Product</th>
              <th className="border-b border-rule-subtle px-4 py-2 text-right font-medium">Before</th>
              <th className="border-b border-rule-subtle px-4 py-2 text-right font-medium">After</th>
              <th className="border-b border-rule-subtle px-4 py-2 text-right font-medium">Δ</th>
            </tr>
          </thead>
          <tbody>
            {changes.map(({ product: p, price }) => (
              <tr key={p.id} className="border-b border-rule-subtle last:border-b-0">
                <td className="px-4 py-2 text-ink break-words">{p.name}</td>
                <td className="px-4 py-2 text-right">
                  <Money cents={p.price} className="text-ink-2" />
                </td>
                <td className="px-4 py-2 text-right">
                  <Money cents={price} className={price !== p.price ? "text-ink font-medium" : "text-ink-2"} />
                </td>
                <td className="px-4 py-2 text-right">{price !== p.price ? <Money cents={price - p.price} signed className="text-ink-2" /> : <span className="text-ink-2">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </Group>
        </SheetSection>

        <Warnings warnings={warnings} />
        {mayEdit.reason ? <p className="text-body text-ink-2">{mayEdit.reason}</p> : null}
        <InlineError error={save.error} />
      </div>
    </Sheet>
    </FieldsLocked>
  );
}
