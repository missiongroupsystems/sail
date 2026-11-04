"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, DataTable, EmptyState, InlineError, Sheet, StatusDot, Switch, type DataTableColumn } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand } from "@/lib/api/types";
import { checkAccent, formatRatio, HEX_RE } from "@/lib/contrast";
import { keys } from "@/lib/query";

type SheetState = { mode: "create" } | { mode: "edit"; brand: Brand } | null;

const Schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  accent_color: z.string().refine((v) => v === "" || HEX_RE.test(v), "Use a 6-digit hex colour, like #B4235E"),
});
type Values = z.infer<typeof Schema>;

function Swatch({ hex }: { hex: string | null }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="inline-block size-4 rounded-full hairline" style={hex ? { background: hex, borderColor: hex } : undefined} />
      <span className="font-mono text-caption">{hex ?? "Not set"}</span>
    </span>
  );
}

function AccentStatus({ hex }: { hex: string | null }) {
  if (!hex) return <span className="text-ink-2">—</span>;
  const check = checkAccent(hex);
  if (!check) return <span className="text-ink-2">—</span>;
  return check.passes ? (
    <StatusDot status="paid" label={`${formatRatio(check.ratio)} · ${check.textOn} text`} />
  ) : (
    <StatusDot status="alert" label={`${formatRatio(check.ratio)} · below 4.5:1`} />
  );
}

const columns: DataTableColumn<Brand>[] = [
  { key: "name", header: "Name", sortable: true, isRowHeader: true, render: (b) => <span className="text-ink">{b.name}</span> },
  { key: "accent_color", header: "Accent", render: (b) => <Swatch hex={b.accent_color} /> },
  { key: "contrast", header: "Button text contrast", render: (b) => <AccentStatus hex={b.accent_color} /> },
  {
    key: "archived",
    header: "Status",
    sortable: true,
    sortValue: (b) => (b.archived ? 1 : 0),
    render: (b) => (b.archived ? <StatusDot status="neutral" label="Archived" muted /> : <StatusDot status="paid" label="Active" />),
  },
];

export function BrandsView({ initialBrands }: { initialBrands: Brand[] }) {
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const brands = useQuery({
    queryKey: keys.brands(true),
    queryFn: () => req(api.GET("/v1/brands", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialBrands,
  });
  const rows = brands.data.filter((b) => showArchived || !b.archived);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2">
          {rows.length} {rows.length === 1 ? "brand" : "brands"}. Brands tint identity (name, accent, tiles); Sail's controls stay the same everywhere.
        </p>
        <div className="flex items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          <Button variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add brand
          </Button>
        </div>
      </div>
      <DataTable
        aria-label="Brands"
        columns={columns}
        rows={rows}
        rowKey={(b) => b.id}
        defaultSort={{ column: "name", direction: "ascending" }}
        onRowAction={(b) => setSheet({ mode: "edit", brand: b })}
        rowClassName={(b) => (b.archived ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="quiet" title="No brands yet" hint="Tap Add brand to create the first one." />}
      />
      <BrandSheet state={sheet} onClose={() => setSheet(null)} />
    </>
  );
}

function BrandSheet({ state, onClose }: { state: SheetState; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const brand = state?.mode === "edit" ? state.brand : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { name: brand?.name ?? "", accent_color: brand?.accent_color ?? "" } });
  const reset = form.reset;
  useEffect(() => {
    if (state) {
      const b = state.mode === "edit" ? state.brand : null;
      reset({ name: b?.name ?? "", accent_color: b?.accent_color ?? "" });
    }
  }, [state, reset]);

  const accent = form.watch("accent_color");
  const check = HEX_RE.test(accent) ? checkAccent(accent) : null;
  const blocked = check !== null && !check.passes;

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: ["brands"] });
    router.refresh();
    onClose();
  };

  const save = useMutation<Brand, ApiError, Values>({
    mutationFn: async (v) => {
      const body = { name: v.name.trim(), accent_color: v.accent_color ? v.accent_color.toUpperCase() : null };
      const res = brand ? await req(api.PATCH("/v1/brands/{id}", { params: { path: { id: brand.id } }, body })) : await req(api.POST("/v1/brands", { body }));
      return res.data;
    },
    onSuccess: settle,
  });
  const archive = useMutation<Brand, ApiError, boolean>({
    mutationFn: async (archived) => (await req(api.PATCH("/v1/brands/{id}", { params: { path: { id: brand!.id } }, body: { archived } }))).data,
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;

  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={brand ? brand.name : "New brand"}
      description={brand?.archived ? "Archived" : "The accent appears on chips here and on buttons in the guest app."}
      footer={
        <>
          {brand ? (
            <Button variant={brand.archived ? "secondary" : "destructive"} onPress={() => archive.mutate(!brand.archived)} isPending={archive.isPending} isDisabled={save.isPending} className="mr-auto">
              {brand.archived ? "Restore brand" : "Archive brand"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="brand-form" isPending={save.isPending} isDisabled={archive.isPending || blocked}>
            {blocked ? "Fix the accent to save" : brand ? "Save changes" : "Add brand"}
          </Button>
        </>
      }
    >
      <form id="brand-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <FormSection>
          <RhfTextField control={form.control} name="name" label="Name" placeholder="Harbour Kitchen" autoFocus={!brand} />
          <div className="flex items-end gap-3">
            <RhfTextField control={form.control} name="accent_color" label="Accent colour" placeholder="#B4235E" mono className="flex-1" description="Leave empty to use Sail's default." />
            <label className="relative flex size-11 shrink-0 cursor-default items-center justify-center rounded-tile hairline" style={{ background: HEX_RE.test(accent) ? accent : "var(--surface-2)" }}>
              <span className="sr-only">Pick accent colour</span>
              <input
                type="color"
                value={HEX_RE.test(accent) ? accent : "#5B4CD6"}
                onChange={(e) => form.setValue("accent_color", e.target.value.toUpperCase(), { shouldDirty: true, shouldValidate: true })}
                className="absolute inset-0 size-full cursor-default opacity-0"
              />
            </label>
          </div>
          {check ? (
            <div className="flex flex-col gap-3 rounded-tile bg-surface-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-body">
                  {check.passes ? (
                    <StatusDot status="paid" label={`Contrast ${formatRatio(check.ratio)} with ${check.textOn} text. Passes 4.5:1.`} />
                  ) : (
                    <StatusDot status="alert" label={`Contrast ${formatRatio(check.ratio)} for button text. Below 4.5:1.`} />
                  )}
                </span>
                <span
                  aria-hidden
                  className="inline-flex min-h-9 items-center rounded-tile px-3 text-caption"
                  style={{ background: check.hex, color: check.textOn === "white" ? "#FFFFFF" : "#1C1D1F" }}
                >
                  Add to order
                </span>
              </div>
              {check.suggestion ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-caption text-ink-2">
                    A {check.suggestion.direction} variant passes: <span className="font-mono text-ink">{check.suggestion.hex}</span> at {formatRatio(check.suggestion.ratio)} with{" "}
                    {check.suggestion.textOn} text.
                  </span>
                  <Button onPress={() => form.setValue("accent_color", check.suggestion!.hex, { shouldDirty: true, shouldValidate: true })}>
                    Use {check.suggestion.hex}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </FormSection>
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
  );
}
