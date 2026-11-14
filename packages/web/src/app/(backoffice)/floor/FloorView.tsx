"use client";

import { Button, Dialog, EmptyState, Icon, InlineError, Select, Switch, TextField, cx, useLocale, Pill } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Users } from "lucide-react";
import { greyPill, greyPillAlert, SectionLabel } from "@/components/office/parts";
import { serverFieldErrors } from "@/components/office/server-errors";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { QrSheetButton, RotateQrButton } from "@/components/backoffice/QrTools";
import { roleIs } from "@/components/backoffice/register";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Area, Outlet, Table, TablePatch } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";
import { useCan } from "@/lib/can";

const COLS = 24;
const ROWS = 14;
const SHAPES = [
  { id: "rect", label: "Rectangle" },
  { id: "square", label: "Square" },
  { id: "round", label: "Round" },
];

type Drag = { id: string; kind: "move" | "resize"; startX: number; startY: number; origin: { x: number; y: number; w: number; h: number }; cell: number; current: { x: number; y: number; w: number; h: number } };

function clampTable(t: { x: number; y: number; w: number; h: number }) {
  const w = Math.max(1, Math.min(COLS, t.w));
  const h = Math.max(1, Math.min(ROWS, t.h));
  return { x: Math.max(0, Math.min(COLS - w, t.x)), y: Math.max(0, Math.min(ROWS - h, t.y)), w, h };
}

/** Floor plan editor (FloorCanvas / TableShape, editor variant). Grid units are what the API stores. */
export function FloorView({ outlets, scope, initialOutletId, initialAreas, initialTables }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; initialAreas: Area[]; initialTables: Table[] }) {
  const canCreate = useCan("areas.create");
  const qc = useQueryClient();
  const { me } = useSession();
  const admin = roleIs(me, "admin");
  const { locale } = useLocale();
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const outlet = outlets.find((o) => o.id === outletId) ?? null;
  const [areaId, setAreaId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [areaDialog, setAreaDialog] = useState<{ mode: "create" } | { mode: "rename"; area: Area } | null>(null);
  const [areaName, setAreaName] = useState("");

  const areas = useQuery({
    queryKey: keys.areas(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/areas", { params: { query: { outlet_id: outletId! } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialAreas : undefined,
  });
  const tables = useQuery({
    queryKey: keys.tables(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/tables", { params: { query: { outlet_id: outletId!, include_archived: "true" } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialTables : undefined,
  });

  const sortedAreas = useMemo(() => (areas.data ?? []).slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, locale)), [areas.data, locale]);
  const area = sortedAreas.find((a) => a.id === areaId) ?? sortedAreas[0] ?? null;
  const areaTables = useMemo(() => (tables.data ?? []).filter((t) => t.area_id === area?.id && (showArchived || !t.archived)), [tables.data, area, showArchived]);
  const selectedTable = areaTables.find((t) => t.id === selected) ?? null;

  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: keys.areas(outletId ?? "") }), qc.invalidateQueries({ queryKey: keys.tables(outletId ?? "") })]);

  const saveArea = useMutation<unknown, ApiError, { id?: string; name: string }>({
    mutationFn: ({ id, name }) => (id ? req(api.PATCH("/v1/areas/{id}", { params: { path: { id } }, body: { name } })) : req(api.POST("/v1/areas", { body: { outlet_id: outletId!, name, sort: sortedAreas.length } }))),
    onSuccess: async () => {
      await invalidate();
      setAreaDialog(null);
    },
  });
  const patchTable = useMutation<{ data: Table }, ApiError, { id: string; body: TablePatch }>({
    mutationFn: ({ id, body }) => req(api.PATCH("/v1/tables/{id}", { params: { path: { id } }, body })),
    onMutate: ({ id, body }) => {
      // Lines may be optimistic: the table moves at once; the register's reply settles it.
      qc.setQueryData<Table[]>(keys.tables(outletId ?? ""), (prev) => prev?.map((t) => (t.id === id ? { ...t, ...body, shape: body.shape ?? t.shape } : t)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.tables(outletId ?? "") }),
  });
  const addTable = useMutation<{ data: Table }, ApiError>({
    mutationFn: () => {
      const taken = new Set(areaTables.map((t) => `${t.x},${t.y}`));
      let x = 0,
        y = 0;
      outer: for (y = 0; y < ROWS; y += 2) for (x = 0; x < COLS; x += 3) if (!taken.has(`${x},${y}`)) break outer;
      return req(api.POST("/v1/tables", { body: { outlet_id: outletId!, area_id: area!.id, name: `T${areaTables.length + 1}`, seats: 4, shape: "rect", x, y, w: 2, h: 2 } }));
    },
    onSuccess: async (r) => {
      await invalidate();
      setSelected(r.data.id);
    },
  });

  // Pointer drag on the canvas: move or resize, snapped to the grid, saved on release.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const startDrag = (e: ReactPointerEvent, t: Table, kind: Drag["kind"]) => {
    if (t.archived) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(t.id);
    setDrag({ id: t.id, kind, startX: e.clientX, startY: e.clientY, origin: { x: t.x, y: t.y, w: t.w, h: t.h }, cell: rect.width / COLS, current: { x: t.x, y: t.y, w: t.w, h: t.h } });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const dx = Math.round((e.clientX - drag.startX) / drag.cell);
    const dy = Math.round((e.clientY - drag.startY) / drag.cell);
    const next = drag.kind === "move" ? clampTable({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }) : clampTable({ ...drag.origin, w: drag.origin.w + dx, h: drag.origin.h + dy });
    if (next.x !== drag.current.x || next.y !== drag.current.y || next.w !== drag.current.w || next.h !== drag.current.h) setDrag({ ...drag, current: next });
  };
  const endDrag = () => {
    if (!drag) return;
    const { origin, current } = drag;
    if (origin.x !== current.x || origin.y !== current.y || origin.w !== current.w || origin.h !== current.h) patchTable.mutate({ id: drag.id, body: current });
    setDrag(null);
  };

  useEffect(() => setSelected(null), [area?.id]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={(id) => { setOutletId(id); setAreaId(null); }} />
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived tables
          </Switch>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {outlet ? <QrSheetButton outletId={outlet.id} outletName={outlet.name} canRotate={admin} /> : null}
          {canCreate.ok ? (
            <Button size="sm" onPress={() => { setAreaName(""); setAreaDialog({ mode: "create" }); }} isDisabled={!outletId}>
            Add area
          </Button>
          ) : null}
          <Button size="sm" variant="primary" onPress={() => addTable.mutate()} isDisabled={!area} isPending={addTable.isPending}>
            Add table
          </Button>
        </div>
      </div>

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="A floor plan belongs to an outlet. Add an outlet first." />
      ) : sortedAreas.length === 0 ? (
        <EmptyState title="No areas yet" hint="Tap Add area: Main dining, Terrace, Bar. Tables live in an area." />
      ) : (
        // The table panel goes beside the plan from 1280px; below that the plan takes the width, so tables keep their size.
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-3">
            <nav aria-label="Areas" className="flex flex-wrap items-center gap-2">
              {/* The same tabs as every other back-office switcher (36px, small rounded tiles), not a 44px pill. */}
              <span className="inline-flex h-9 max-w-full flex-wrap items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
                {sortedAreas.map((a) => (
                  <Button
                    key={a.id}
                    variant="quiet"
                    aria-current={a.id === area?.id ? "true" : undefined}
                    onPress={() => setAreaId(a.id)}
                    className={cx("h-8! min-h-8! rounded-[8px]! px-3! text-[13px]", a.id === area?.id ? "bg-surface! text-ink shadow-segment" : "text-ink-2")}
                  >
                    {a.name}
                  </Button>
                ))}
              </span>
              {area ? (
                <Button variant="quiet" className="text-[13px] text-ink-2" onPress={() => { setAreaName(area.name); setAreaDialog({ mode: "rename", area }); }}>
                  Rename {area.name}
                </Button>
              ) : null}
            </nav>
            {/* On a phone the plan keeps a workable size (tables about 46pt) and scrolls sideways inside its frame. */}
            <div className="overflow-x-auto rounded-panel bg-surface-2 p-2 sm:p-3">
            <div
              ref={canvasRef}
              role="application"
              aria-label={`Floor plan for ${area?.name ?? "area"}`}
              className="relative w-full select-none overflow-hidden rounded-[10px] bg-surface touch-none shadow-[inset_0_0_0_1px_var(--line-subtle)] max-sm:min-w-[560px]"
              style={{
                aspectRatio: `${COLS} / ${ROWS}`,
                backgroundImage: "radial-gradient(circle at 0 0, var(--line-strong) 1.2px, transparent 1.4px)",
                backgroundSize: `${100 / COLS}% ${100 / ROWS}%`,
              }}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerDown={() => setSelected(null)}
            >
              {areaTables.map((t) => {
                const pos = drag?.id === t.id ? drag.current : { x: t.x, y: t.y, w: t.w, h: t.h };
                const isSelected = t.id === selected;
                return (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${t.name}, ${t.seats} seats, ${t.shape}${t.archived ? ", archived" : ""}`}
                    aria-pressed={isSelected}
                    onPointerDown={(e) => startDrag(e, t, "move")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(t.id);
                      }
                      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
                      if (d && !t.archived) {
                        e.preventDefault();
                        patchTable.mutate({ id: t.id, body: clampTable({ x: t.x + d[0]!, y: t.y + d[1]!, w: t.w, h: t.h }) });
                      }
                    }}
                    className={cx(
                      "absolute flex border p-0.5 outline-none transition-[left,top,width,height] duration-[80ms] sm:p-2",
                      t.shape === "round" ? "items-center justify-center rounded-full text-center" : "items-center justify-center rounded-[14px] text-center sm:items-start sm:justify-start sm:text-left",
                      t.archived ? "border-dashed border-rule-dashed bg-surface-2/60 text-ink-3" : "border-dashed border-ink-3/60 bg-surface text-ink hover:border-ink-2",
                      isSelected && "border-solid border-ink outline-solid outline-2 outline-offset-2 outline-ink",
                      drag?.id === t.id && "cursor-grabbing shadow-sheet",
                      !t.archived && !drag && "cursor-grab",
                      "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                    )}
                    style={{ left: `calc(${(pos.x / COLS) * 100}% + 3px)`, top: `calc(${(pos.y / ROWS) * 100}% + 3px)`, width: `calc(${(pos.w / COLS) * 100}% - 6px)`, height: `calc(${(pos.h / ROWS) * 100}% - 6px)` }}
                  >
                    <span className={cx("flex min-w-0 flex-col gap-1 overflow-hidden leading-none", t.shape === "round" && "items-center")}>
                      <span className="truncate font-heading text-[clamp(10px,1.4vw,20px)] font-semibold">{t.name}</span>
                      <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-3 tabular max-sm:hidden">
                        <Icon icon={Users} size={12} />
                        {t.seats}
                      </span>
                    </span>
                    {isSelected && !t.archived ? (
                      <span
                        role="presentation"
                        aria-hidden
                        onPointerDown={(e) => startDrag(e, t, "resize")}
                        className="absolute right-0 bottom-0 size-4 translate-x-1/3 translate-y-1/3 cursor-nwse-resize rounded-full border-2 border-surface bg-ink"
                      />
                    ) : null}
                  </div>
                );
              })}
              {areaTables.length === 0 ? <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center text-[15px] text-ink-2">No tables in {area?.name}. Tap Add table.</p> : null}
            </div>
            </div>
            <InlineError error={patchTable.error ?? addTable.error ?? areas.error ?? tables.error} />
          </div>

          <aside className="flex flex-col gap-4 self-start rounded-panel border border-rule bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 font-heading text-[17px] leading-[1.3] font-semibold text-ink [overflow-wrap:anywhere]">{selectedTable ? selectedTable.name : "Table"}</h2>
              {selectedTable ? selectedTable.archived ? <Pill size="sm" tone="neutral">Archived</Pill> : <span className="text-[13px] text-ink-3 tabular">{selectedTable.seats} seats</span> : null}
            </div>
            {selectedTable ? (
              <TablePanel key={selectedTable.id} table={selectedTable} areas={sortedAreas} onSave={(body) => patchTable.mutate({ id: selectedTable.id, body })} saving={patchTable.isPending} canRotateQr={admin} error={patchTable.variables?.id === selectedTable.id ? patchTable.error : null} />
            ) : (
              <p className="text-[14px] text-ink-2">Tap a table to edit its name, seats, shape and size, or to rotate its QR code. Drag it to move it; drag the corner to resize. Arrow keys nudge a focused table.</p>
            )}
          </aside>
        </div>
      )}

      <Dialog
        isOpen={areaDialog !== null}
        onOpenChange={(open) => !open && setAreaDialog(null)}
        title={areaDialog?.mode === "rename" ? `Rename ${areaDialog.area.name}` : "New area"}
        footer={
          <>
            <Button variant="secondary" className={greyPill} onPress={() => setAreaDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" isDisabled={!areaName.trim()} isPending={saveArea.isPending} onPress={() => saveArea.mutate({ id: areaDialog?.mode === "rename" ? areaDialog.area.id : undefined, name: areaName.trim() })}>
              {areaDialog?.mode === "rename" ? "Rename area" : "Add area"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pt-2">
          <TextField label="Name" value={areaName} onChange={setAreaName} placeholder="Main dining" autoFocus />
          <InlineError error={saveArea.error} />
        </div>
      </Dialog>
    </>
  );
}

function TablePanel({ table, areas, onSave, saving, canRotateQr, error }: { table: Table; areas: Area[]; onSave: (body: TablePatch) => void; saving: boolean; canRotateQr: boolean; error: ApiError | null }) {
  // A refusal that names a field (seats over the limit, a name) shows under that field as well as under the plan.
  const fieldError = (name: string) => serverFieldErrors(error).find((e) => e.field === name)?.message;
  const [name, setName] = useState(table.name);
  const [seats, setSeats] = useState(String(table.seats));
  const [shape, setShape] = useState(table.shape);
  const [areaId, setAreaId] = useState(table.area_id);
  const [geom, setGeom] = useState({ x: String(table.x), y: String(table.y), w: String(table.w), h: String(table.h) });
  useEffect(() => setGeom({ x: String(table.x), y: String(table.y), w: String(table.w), h: String(table.h) }), [table.x, table.y, table.w, table.h]);
  const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const valid = name.trim() && int(seats) !== null && int(geom.x) !== null && int(geom.y) !== null && int(geom.w) !== null && int(geom.h) !== null;

  const save = () => {
    if (!valid) return;
    const g = clampTable({ x: int(geom.x)!, y: int(geom.y)!, w: int(geom.w)!, h: int(geom.h)! });
    onSave({ name: name.trim(), seats: int(seats)!, shape: shape as "rect" | "round" | "square", area_id: areaId, ...g });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <TextField label="Name" value={name} onChange={setName} isInvalid={!!fieldError("name")} errorMessage={fieldError("name")} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Seats" numeric inputMode="numeric" value={seats} onChange={setSeats} isInvalid={!!fieldError("seats")} errorMessage={fieldError("seats")} />
        <Select label="Shape" selectedKey={shape} onSelectionChange={(k) => k && setShape(k)} items={SHAPES} />
      </div>
      <Select label="Area" selectedKey={areaId} onSelectionChange={(k) => k && setAreaId(k)} items={areas.map((a) => ({ id: a.id, label: a.name }))} />
      <div className="grid grid-cols-4 gap-2">
        <TextField label="X" numeric inputMode="numeric" value={geom.x} onChange={(v) => setGeom({ ...geom, x: v })} />
        <TextField label="Y" numeric inputMode="numeric" value={geom.y} onChange={(v) => setGeom({ ...geom, y: v })} />
        <TextField label="W" numeric inputMode="numeric" value={geom.w} onChange={(v) => setGeom({ ...geom, w: v })} />
        <TextField label="H" numeric inputMode="numeric" value={geom.h} onChange={(v) => setGeom({ ...geom, h: v })} />
      </div>
      <p className="text-[12.5px] text-ink-3">
        Grid of {COLS} × {ROWS}. Position and size are in grid units.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" isDisabled={!valid} isPending={saving}>
          Save table
        </Button>
        <Button variant="secondary" className={table.archived ? greyPill : greyPillAlert} onPress={() => onSave({ archived: !table.archived })} isDisabled={saving}>
          {table.archived ? "Restore" : "Archive"}
        </Button>
      </div>
      <section className="flex flex-col gap-2.5 border-t border-rule-subtle pt-4">
        <SectionLabel>QR code</SectionLabel>
        <RotateQrButton table={table} canRotate={canRotateQr} />
      </section>
    </form>
  );
}
