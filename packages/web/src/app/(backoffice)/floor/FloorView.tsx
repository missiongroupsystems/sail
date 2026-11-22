"use client";

import { useConfirm } from "@/components/backoffice/Confirm";
import { Button, Dialog, EmptyState, FieldsLocked, Icon, InlineError, PageHeader, Select, Switch, TextField, cx, useLocale, Pill } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where a new table of w × h goes: the first place on the visible grid that touches no table already there. It looks
 * along the plan's usual rhythm first (a column and a row of space between tables), then at every cell. A plan with no
 * room left gets it in the top-left corner, selected, to be dragged or resized.
 */
export function freeCell(taken: Box[], w = 2, h = 2): { x: number; y: number } {
  const free = (x: number, y: number) => x + w <= COLS && y + h <= ROWS && !taken.some((t) => overlaps({ x, y, w, h }, t));
  for (const [dx, dy] of [[w + 1, h], [1, 1]] as const) for (let y = 0; y + h <= ROWS; y += dy) for (let x = 0; x + w <= COLS; x += dx) if (free(x, y)) return { x, y };
  return { x: 0, y: 0 };
}

/** The page's intro says what the signed-in role can do here: an Admin edits the plan, a role below reads it (L1). */
export function FloorIntro() {
  const canEdit = useCan("tables.update").ok;
  const description = canEdit
    ? "Areas and tables per outlet. Drag a table to move it; select it to edit. Download the QR sheet for the tables, or rotate one table's code."
    : "Areas and tables per outlet. Select a table to see its name, seats and shape. The QR codes and their sheet need an Admin.";
  return <PageHeader title="Floor & QR" description={description} />;
}

/** Floor plan editor (FloorCanvas / TableShape, editor variant). Grid units are what the API stores. */
export function FloorView({ outlets, scope, initialOutletId, initialAreas, initialTables }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; initialAreas: Area[]; initialTables: Table[] }) {
  const canCreate = useCan("areas.create");
  // What a role below Admin cannot do is left out or turned off with the reason, not refused after the act (R new 1).
  const canAddTable = useCan("tables.create");
  const canRenameArea = useCan("areas.update");
  const canEditTable = useCan("tables.update");
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

  // Printed codes order nothing until the outlet has a Scan to order channel switched on: say so here, where the
  // codes are printed, not only on the guest's phone.
  const qrLinks = useQuery({
    queryKey: ["channel-links", "scan_to_order", outletId ?? ""],
    queryFn: () => req(api.GET("/v1/channel-links", { params: { query: { channel: "scan_to_order", outlet_id: outletId! } } })).then((r) => r.data),
    enabled: outletId !== null,
  });
  const qrOff = outlet !== null && qrLinks.data !== undefined && !qrLinks.data.some((l) => l.enabled && l.outlet_id === outletId) && (tables.data ?? []).some((t) => !t.archived);
  const qrOffNote = qrOff ? `The QR codes at ${outlet.name} do not take orders yet: the outlet has no Scan to order channel switched on. A guest who scans one is asked to speak to the staff.` : null;

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
  // A refused change stays on show for its table until those fields save, or the panel is back to the register's
  // values; a later save of something else does not clear it.
  const [refusals, setRefusals] = useState<Record<string, { error: ApiError; fields: string[] }>>({});
  const settleRefusal = useCallback((id: string, fields: string[]) => {
    setRefusals((all) => {
      const left = all[id]?.fields.filter((f) => !fields.includes(f));
      if (!left) return all;
      const next = { ...all };
      if (left.length) next[id] = { ...all[id]!, fields: left };
      else delete next[id];
      return next;
    });
  }, []);
  const patchTable = useMutation<{ data: Table }, ApiError, { id: string; body: TablePatch }, { before: Table | undefined }>({
    // One change at a time, in the order made: typing and dragging send several, and a later one must not land first.
    // (A scope is set per hook, not per call, so this queues every table's changes, which are small.)
    scope: { id: "floor-table-patch" },
    mutationFn: ({ id, body }) => req(api.PATCH("/v1/tables/{id}", { params: { path: { id } }, body })),
    onMutate: async ({ id, body }) => {
      // A read still on its way would put the old table back over the change for a moment.
      await qc.cancelQueries({ queryKey: keys.tables(outletId ?? "") });
      const before = qc.getQueryData<Table[]>(keys.tables(outletId ?? ""))?.find((t) => t.id === id);
      // Lines may be optimistic: the table moves at once; the register's reply settles it.
      qc.setQueryData<Table[]>(keys.tables(outletId ?? ""), (prev) => prev?.map((t) => (t.id === id ? { ...t, ...body, shape: body.shape ?? t.shape } : t)));
      return { before };
    },
    onError: (error, { id, body }, ctx) => {
      const fields = Object.keys(body);
      // The refused fields go back to what they were, so the panel can tell its unsaved text from the register's.
      const before = ctx?.before;
      if (before) qc.setQueryData<Table[]>(keys.tables(outletId ?? ""), (prev) => prev?.map((t) => (t.id === id ? { ...t, ...Object.fromEntries(fields.map((f) => [f, before[f as keyof Table]])) } : t)));
      setRefusals((all) => ({ ...all, [id]: { error, fields: [...new Set([...(all[id]?.fields ?? []), ...fields])] } }));
    },
    // A refused choice (shape, area, archived) shows the register's value again at once, so the table's next save that
    // goes through ends it; a refused typed value is ended only by a save of that field.
    onSuccess: (_, { id, body }) => settleRefusal(id, [...Object.keys(body), "shape", "area_id", "archived"]),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.tables(outletId ?? "") }),
  });
  const addTable = useMutation<{ data: Table }, ApiError>({
    mutationFn: () => {
      // Clear of every table on the plan, whatever its size and wherever it was dragged (the first free origin on a
      // fixed lattice put a new table under a larger or moved one), and of the archived ones while they are shown.
      const { x, y } = freeCell(areaTables);
      // The next T number no table of the outlet has, so two areas do not both get a T1.
      const names = new Set((tables.data ?? []).map((t) => t.name.trim().toLowerCase()));
      let n = areaTables.length + 1;
      while (names.has(`t${n}`)) n++;
      return req(api.POST("/v1/tables", { body: { outlet_id: outletId!, area_id: area!.id, name: `T${n}`, seats: 4, shape: "rect", x, y, w: 2, h: 2 } }));
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
    // A tap always opens the table's details, for a role that may only read them too (L1); only a drag needs the right.
    e.stopPropagation();
    setSelected(t.id);
    if (t.archived || !canEditTable.ok) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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

  // Another area starts with nothing selected, unless the selected table was just moved there: then the plan follows it.
  const follow = useRef<string | null>(null);
  useEffect(() => {
    setSelected(follow.current);
    follow.current = null;
  }, [area?.id]);
  const saveSelected = (t: Table, body: TablePatch) => {
    if (body.area_id && body.area_id !== t.area_id) {
      follow.current = t.id;
      setAreaId(body.area_id);
    }
    patchTable.mutate({ id: t.id, body });
  };

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
          {outlet ? <QrSheetButton outletId={outlet.id} outletName={outlet.name} canRotate={admin} warning={qrOffNote ? "These codes do not take orders yet: see the note below." : null} /> : null}
          {canCreate.ok ? (
            <Button size="sm" onPress={() => { setAreaName(""); setAreaDialog({ mode: "create" }); }} isDisabled={!outletId}>
            Add area
          </Button>
          ) : null}
          {canAddTable.ok ? (
            <Button size="sm" variant="primary" onPress={() => addTable.mutate()} isDisabled={!area} isPending={addTable.isPending}>
              Add table
            </Button>
          ) : null}
        </div>
      </div>

      {qrOffNote ? (
        <p role="alert" className="mb-4 rounded-panel bg-status-sent-tint px-4 py-3 text-[14px] text-ink">
          {qrOffNote}{" "}
          <Link href="/settings/channels" className="text-ink underline underline-offset-4">
            Set it up in Settings › Channels
          </Link>
          .
        </p>
      ) : null}
      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="A floor plan belongs to an outlet. Add an outlet first." />
      ) : sortedAreas.length === 0 ? (
        <EmptyState title="No areas yet" hint="Select Add area: Main dining, Terrace, Bar. Tables live in an area." />
      ) : (
        // The table panel goes beside the plan from 1280px; below that the plan takes the width, so tables keep their size.
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-3">
            <nav aria-label="Areas" className="flex flex-wrap items-center gap-2">
              {/* The same tabs as every other back-office switcher (36px, small rounded tiles), not a 44px pill. */}
              <span className="inline-flex h-9 max-sm:h-auto max-w-full flex-wrap items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
                {sortedAreas.map((a) => (
                  <Button
                    key={a.id}
                    variant="quiet"
                    aria-current={a.id === area?.id ? "true" : undefined}
                    onPress={() => setAreaId(a.id)}
                    className={cx("h-8! min-h-8! max-sm:h-11! max-sm:min-h-11! rounded-[8px]! px-3! text-[13px]", a.id === area?.id ? "bg-surface! text-ink shadow-segment" : "text-ink-2")}
                  >
                    {a.name}
                  </Button>
                ))}
              </span>
              {area && canRenameArea.ok ? (
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
                      if (d && !t.archived && canEditTable.ok) {
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
                      !t.archived && !drag && canEditTable.ok && "cursor-grab",
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
                    {isSelected && !t.archived && canEditTable.ok ? (
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
              {areaTables.length === 0 ? <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center text-[15px] text-ink-2">No tables in {area?.name}.{canAddTable.ok ? " Select Add table." : ""}</p> : null}
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
              <TablePanel key={selectedTable.id} table={selectedTable} areas={sortedAreas} onSave={(body) => saveSelected(selectedTable, body)} saving={patchTable.isPending} canRotateQr={admin} denied={canEditTable.reason} refusal={refusals[selectedTable.id] ?? null} onSynced={(fields) => settleRefusal(selectedTable.id, fields)} />
            ) : (
              <p className="text-[14px] text-ink-2">{canEditTable.ok ? "Select a table to edit its name, seats, shape and size, or to rotate its QR code. Drag it to move it; drag the corner to resize. Arrow keys nudge a focused table." : `Select a table to see its details. ${canEditTable.reason}`}</p>
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

/** How long after the last keystroke a typed change is sent, when the field has not been left first. */
const TYPING_PAUSE_MS = 400;

/**
 * A table's details. Every change applies as it is made, as a drag on the plan does: a choice (shape, area) at once, a
 * typed value when the field is left, on Enter, or after a short pause in typing. There is no Save button to forget.
 * A value that cannot be used (no name, seats that are not a number) says so under its field and is not sent; a value
 * the register refuses shows the register's reason there.
 */
function TablePanel({ table, areas, onSave, saving, canRotateQr, denied, refusal, onSynced }: { table: Table; areas: Area[]; onSave: (body: TablePatch) => void; saving: boolean; canRotateQr: boolean; denied: string | null; refusal: { error: ApiError; fields: string[] } | null; onSynced: (fields: string[]) => void }) {
  const confirm = useConfirm();
  const error = refusal?.error ?? null;
  // A refusal that names a field (seats over the limit, a name) shows under that field as well as under the plan.
  const refused = (name: string) => serverFieldErrors(error).find((e) => e.field === name)?.message;
  const [name, setName] = useState(table.name);
  const [seats, setSeats] = useState(String(table.seats));
  const [geom, setGeom] = useState({ x: String(table.x), y: String(table.y), w: String(table.w), h: String(table.h) });
  // A drag on the plan, or a position the grid had to pull back inside, shows in the fields.
  useEffect(() => setGeom({ x: String(table.x), y: String(table.y), w: String(table.w), h: String(table.h) }), [table.x, table.y, table.w, table.h]);
  const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
  const seatCount = int(seats);
  const problem = {
    name: name.trim() ? undefined : "Enter a name",
    seats: seatCount === null ? "Enter a whole number" : seatCount < 1 || seatCount > 99 ? "From 1 to 99 seats" : undefined,
    geom: int(geom.x) === null || int(geom.y) === null || !int(geom.w) || !int(geom.h) ? "Position and size are whole numbers; width and height at least 1." : undefined,
  };

  // A refused field whose text is the register's value again (typed back, or the table moved back) has nothing left unsaved.
  const shown: Record<string, string> = { name: name.trim(), seats: seats.trim(), ...geom };
  const synced = refusal?.fields.filter((f) => f in shown && shown[f] === String(table[f as keyof Table])) ?? [];
  const syncedKey = synced.join();
  useEffect(() => {
    if (!saving && syncedKey) onSynced(syncedKey.split(","));
  }, [saving, syncedKey, onSynced]);

  // The pause timer and the unmount both send what is in the fields then, not what was there when they were set up.
  const latest = useRef({ table, name, seats, geom, problem, onSave, denied });
  latest.current = { table, name, seats, geom, problem, onSave, denied };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const now = latest.current;
    if (now.denied !== null) return;
    const body: TablePatch = {};
    if (!now.problem.name && now.name.trim() !== now.table.name) body.name = now.name.trim();
    if (!now.problem.seats && Number(now.seats.trim()) !== now.table.seats) body.seats = Number(now.seats.trim());
    if (!now.problem.geom) {
      const g = clampTable({ x: Number(now.geom.x), y: Number(now.geom.y), w: Number(now.geom.w), h: Number(now.geom.h) });
      if (g.x !== now.table.x || g.y !== now.table.y || g.w !== now.table.w || g.h !== now.table.h) Object.assign(body, g);
      // A number past the edge of the grid is pulled back inside, and the field shows where the table went.
      else setGeom({ x: String(g.x), y: String(g.y), w: String(g.w), h: String(g.h) });
    }
    if (Object.keys(body).length) now.onSave(body);
  }, []);
  const typed = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(send, TYPING_PAUSE_MS);
  };
  // Selecting another table mid-pause still sends what was typed.
  useEffect(() => () => {
    if (timer.current) send();
  }, [send]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <FieldsLocked locked={denied !== null}>
      <TextField label="Name" value={name} onChange={(v) => { setName(v); typed(); }} onBlur={send} isInvalid={!!(problem.name ?? refused("name"))} errorMessage={problem.name ?? refused("name")} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Seats" numeric inputMode="numeric" value={seats} onChange={(v) => { setSeats(v); typed(); }} onBlur={send} isInvalid={!!(problem.seats ?? refused("seats"))} errorMessage={problem.seats ?? refused("seats")} />
        <Select label="Shape" selectedKey={table.shape} onSelectionChange={(k) => k && k !== table.shape && onSave({ shape: k as "rect" | "round" | "square" })} items={SHAPES} />
      </div>
      <Select label="Area" selectedKey={table.area_id} onSelectionChange={(k) => k && k !== table.area_id && onSave({ area_id: k })} items={areas.map((a) => ({ id: a.id, label: a.name }))} />
      <div className="grid grid-cols-4 gap-2">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <TextField key={k} label={k.toUpperCase()} numeric inputMode="numeric" value={geom[k]} onChange={(v) => { setGeom((g) => ({ ...g, [k]: v })); typed(); }} onBlur={send} isInvalid={!!problem.geom && (int(geom[k]) === null || ((k === "w" || k === "h") && !int(geom[k])))} />
        ))}
      </div>
      {problem.geom ? (
        <p role="alert" className="text-caption text-status-alert">
          {problem.geom}
        </p>
      ) : null}
      <p className="text-[12.5px] text-ink-3">
        Grid of {COLS} × {ROWS}. Position and size are in grid units.
      </p>
      </FieldsLocked>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className={table.archived ? greyPill : greyPillAlert} onPress={() => (table.archived ? onSave({ archived: false }) : confirm.ask({ title: `Archive ${table.name}?`, body: "It leaves the floor plan on the POS. Past orders keep it. You can restore it later.", confirmLabel: "Archive table", cancelLabel: "Keep the table", onConfirm: () => onSave({ archived: true }) }))} isDisabled={saving || denied !== null}>
          {table.archived ? "Restore" : "Archive"}
        </Button>
        {/* In the place Save table had: what happens to a change, and that the last one has gone through. */}
        {denied === null ? (
          <p role="status" className="text-[12.5px] text-ink-3">
            {saving ? "Saving…" : error ? "Not saved yet." : "Changes save as you make them."}
          </p>
        ) : null}
        {confirm.dialog}
      </div>
      {error && !saving ? (
        <p role="alert" className="text-caption text-status-alert">
          {error.message}
          {error.remedy ? ` ${error.remedy}` : ""}
        </p>
      ) : null}
      {denied ? <p className="text-[12.5px] text-ink-3">{denied}</p> : null}
      <section className="flex flex-col gap-2.5 border-t border-rule-subtle pt-4">
        <SectionLabel>QR code</SectionLabel>
        {canRotateQr ? <RotateQrButton table={table} canRotate /> : <p className="text-[12.5px] text-ink-3">The code on {table.name} is printed on the QR sheet. Downloading the sheet and rotating a code need an Admin.</p>}
      </section>
    </form>
  );
}
