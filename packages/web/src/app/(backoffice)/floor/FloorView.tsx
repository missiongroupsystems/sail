"use client";

import { Button, Dialog, EmptyState, InlineError, SectionHeading, Select, StatusDot, Switch, TextField, cx } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { QrSheetButton, RotateQrButton } from "@/components/backoffice/QrTools";
import { roleIs } from "@/components/backoffice/register";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Area, Outlet, Table, TablePatch } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";

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
  const qc = useQueryClient();
  const { me } = useSession();
  const admin = roleIs(me, "admin");
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

  const sortedAreas = useMemo(() => (areas.data ?? []).slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)), [areas.data]);
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
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={(id) => { setOutletId(id); setAreaId(null); }} />
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived tables
          </Switch>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {outlet ? <QrSheetButton outletId={outlet.id} outletName={outlet.name} canRotate={admin} /> : null}
          <Button onPress={() => { setAreaName(""); setAreaDialog({ mode: "create" }); }} isDisabled={!outletId}>
            Add area
          </Button>
          <Button variant="primary" onPress={() => addTable.mutate()} isDisabled={!area} isPending={addTable.isPending}>
            Add table
          </Button>
        </div>
      </div>

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="A floor plan belongs to an outlet. Add an outlet first." />
      ) : sortedAreas.length === 0 ? (
        <EmptyState title="No areas yet" hint="Tap Add area: Main dining, Terrace, Bar. Tables live in an area." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-3">
            <nav aria-label="Areas" className="-mx-1 flex flex-wrap items-center gap-1">
              {sortedAreas.map((a) => (
                <Button key={a.id} variant={a.id === area?.id ? "secondary" : "quiet"} onPress={() => setAreaId(a.id)} className={a.id === area?.id ? "text-ink" : "text-ink-2"}>
                  {a.name}
                </Button>
              ))}
              {area ? (
                <Button variant="quiet" className="text-caption text-ink-2" onPress={() => { setAreaName(area.name); setAreaDialog({ mode: "rename", area }); }}>
                  Rename {area.name}
                </Button>
              ) : null}
            </nav>
            <div
              ref={canvasRef}
              role="application"
              aria-label={`Floor plan for ${area?.name ?? "area"}`}
              className="relative w-full select-none overflow-hidden rounded-tile hairline bg-surface touch-none"
              style={{
                aspectRatio: `${COLS} / ${ROWS}`,
                backgroundImage: "linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px)",
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
                      "absolute flex items-center justify-center text-center outline-none transition-[left,top,width,height] duration-[80ms]",
                      t.shape === "round" ? "rounded-full" : "rounded-tile",
                      t.archived ? "border border-dashed border-rule text-ink-2" : "bg-surface-2 text-ink hairline hover:border-ink-2",
                      isSelected && "border-ink ring-2 ring-status-seated ring-offset-1 ring-offset-surface",
                      drag?.id === t.id && "cursor-grabbing shadow-sheet",
                      !t.archived && !drag && "cursor-grab",
                      "focus-visible:ring-2 focus-visible:ring-status-seated",
                    )}
                    style={{ left: `${(pos.x / COLS) * 100}%`, top: `${(pos.y / ROWS) * 100}%`, width: `${(pos.w / COLS) * 100}%`, height: `${(pos.h / ROWS) * 100}%` }}
                  >
                    <span className="flex flex-col leading-tight">
                      <span className="text-line">{t.name}</span>
                      <span className="text-caption text-ink-2 tabular">{t.seats}</span>
                    </span>
                    {isSelected && !t.archived ? (
                      <span
                        role="presentation"
                        aria-hidden
                        onPointerDown={(e) => startDrag(e, t, "resize")}
                        className="absolute right-0 bottom-0 size-4 translate-x-1/3 translate-y-1/3 cursor-nwse-resize rounded-full bg-status-seated"
                      />
                    ) : null}
                  </div>
                );
              })}
              {areaTables.length === 0 ? <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-ink-2">No tables in {area?.name}. Tap Add table.</p> : null}
            </div>
            <InlineError error={patchTable.error ?? addTable.error ?? areas.error ?? tables.error} />
          </div>

          <aside className="flex flex-col gap-4">
            <SectionHeading title={selectedTable ? selectedTable.name : "Table"} aside={selectedTable ? (selectedTable.archived ? <StatusDot status="neutral" label="Archived" muted /> : `${selectedTable.seats} seats`) : null} />
            {selectedTable ? (
              <TablePanel key={selectedTable.id} table={selectedTable} areas={sortedAreas} onSave={(body) => patchTable.mutate({ id: selectedTable.id, body })} saving={patchTable.isPending} canRotateQr={admin} />
            ) : (
              <p className="text-ink-2">Tap a table to edit its name, seats, shape and size, or to rotate its QR code. Drag it to move it; drag the corner to resize. Arrow keys nudge a focused table.</p>
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
            <Button variant="quiet" onPress={() => setAreaDialog(null)}>
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

function TablePanel({ table, areas, onSave, saving, canRotateQr }: { table: Table; areas: Area[]; onSave: (body: TablePatch) => void; saving: boolean; canRotateQr: boolean }) {
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
      <TextField label="Name" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Seats" numeric inputMode="numeric" value={seats} onChange={setSeats} />
        <Select label="Shape" selectedKey={shape} onSelectionChange={(k) => k && setShape(k)} items={SHAPES} />
      </div>
      <Select label="Area" selectedKey={areaId} onSelectionChange={(k) => k && setAreaId(k)} items={areas.map((a) => ({ id: a.id, label: a.name }))} />
      <div className="grid grid-cols-4 gap-2">
        <TextField label="X" numeric inputMode="numeric" value={geom.x} onChange={(v) => setGeom({ ...geom, x: v })} />
        <TextField label="Y" numeric inputMode="numeric" value={geom.y} onChange={(v) => setGeom({ ...geom, y: v })} />
        <TextField label="W" numeric inputMode="numeric" value={geom.w} onChange={(v) => setGeom({ ...geom, w: v })} />
        <TextField label="H" numeric inputMode="numeric" value={geom.h} onChange={(v) => setGeom({ ...geom, h: v })} />
      </div>
      <p className="text-caption text-ink-2">
        Grid of {COLS} × {ROWS}. Position and size are in grid units.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" isDisabled={!valid} isPending={saving}>
          Save table
        </Button>
        <Button variant={table.archived ? "secondary" : "destructive"} onPress={() => onSave({ archived: !table.archived })} isDisabled={saving}>
          {table.archived ? "Restore" : "Archive"}
        </Button>
      </div>
      <section className="flex flex-col gap-2 pt-2 hairline-t">
        <h3 className="pt-2 text-line text-ink">QR code</h3>
        <RotateQrButton table={table} canRotate={canRotateQr} />
      </section>
    </form>
  );
}
