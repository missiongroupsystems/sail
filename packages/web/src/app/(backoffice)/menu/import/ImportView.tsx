"use client";

import { Button, DataTable, DescriptionList, EmptyState, Icon, InlineError, Select, Stat, TextField, type DataTableColumn, useLocale, Pill } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Warnings } from "@/components/backoffice/Warnings";
import { Group, Quiet, SectionLabel } from "@/components/office/parts";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { ImportEntity, ImportJob, ImportJobSummary, ImportMapping, ImportReport } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";
import { autoMap, csvHeader, csvRowCount, ENTITY_LABEL, ENTITY_ORDER, FIELDS, guessEntity } from "./import-fields";

type Upload = { name: string; text: string; headers: string[]; rows: number; entity: ImportEntity | null; columns: Record<string, string> };

const NONE = "__none__";
const ANY = "__any__";
const RUNNING = new Set(["queued", "running"]);

const STATUS_LABEL: Record<ImportJob["status"], string> = { queued: "Queued", running: "Running", dry_run_complete: "Dry run complete", applied: "Applied", failed: "Failed" };

function statusDot(j: { status: ImportJob["status"]; dry_run: boolean }) {
  switch (j.status) {
    case "queued":
    case "running":
      return <Pill size="sm" tone="sent">{STATUS_LABEL[j.status]}</Pill>;
    case "dry_run_complete":
      return <Pill size="sm" tone="seated">Dry run complete</Pill>;
    case "applied":
      return <Pill size="sm" tone="paid">Applied</Pill>;
    case "failed":
      return <Pill size="sm" tone="alert">Failed</Pill>;
  }
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/**
 * The legacy POS importer (summary first). Upload CSVs, map
 * columns, queue a dry run, read the report, then apply. Every number on this
 * page comes from the register's report.
 */
export function ImportView({ initialJobs }: { initialJobs: ImportJobSummary[] }) {
  const { dayClock } = useLocale();
  const { me } = useSession();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [brandLegacyId, setBrandLegacyId] = useState("");
  const [outletLegacyId, setOutletLegacyId] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const jobs = useQuery({
    queryKey: keys.imports,
    queryFn: () => req(api.GET("/v1/imports")).then((r) => r.data),
    initialData: initialJobs,
    refetchInterval: (q) => (q.state.data?.some((j) => RUNNING.has(j.status)) ? 3_000 : false),
  });

  const job = useQuery({
    queryKey: keys.importJob(jobId ?? ""),
    queryFn: () => req(api.GET("/v1/imports/{id}", { params: { path: { id: jobId! } } })).then((r) => r.data),
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data && RUNNING.has(q.state.data.status) ? 2_000 : false),
  });

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setReadError(null);
    try {
      const next: Upload[] = [];
      for (const f of Array.from(files)) {
        const text = await readText(f);
        const headers = csvHeader(text);
        const entity = guessEntity(f.name);
        next.push({ name: f.name, text, headers, rows: csvRowCount(text), entity, columns: entity ? autoMap(FIELDS[entity], headers) : {} });
      }
      setUploads((prev) => [...prev.filter((u) => !next.some((n) => n.name === u.name)), ...next]);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "The file could not be read");
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const update = (name: string, patch: Partial<Upload>) => setUploads((prev) => prev.map((u) => (u.name === name ? { ...u, ...patch } : u)));

  const problems = useMemo(() => {
    const out: string[] = [];
    for (const u of uploads) {
      if (!u.entity) out.push(`${u.name}: choose what the file contains.`);
      else for (const f of FIELDS[u.entity]) if (f.required && !u.columns[f.name]) out.push(`${u.name}: map the required field "${f.name}".`);
    }
    return out;
  }, [uploads]);

  const mapping = (): ImportMapping => ({
    files: uploads.map((u) => ({ name: u.name, entity: u.entity!, columns: u.columns })),
    options: { ...(brandLegacyId.trim() ? { brand_legacy_id: brandLegacyId.trim() } : {}), ...(outletLegacyId.trim() ? { outlet_legacy_id: outletLegacyId.trim() } : {}) },
  });

  const dryRun = useMutation<{ data: ImportJob }, ApiError>({
    mutationFn: () => req(api.POST("/v1/imports", { body: { mapping: mapping(), files: Object.fromEntries(uploads.map((u) => [u.name, u.text])), dry_run: true } })),
    onSuccess: async (r) => {
      setJobId(r.data.id);
      await qc.invalidateQueries({ queryKey: keys.imports });
    },
  });
  const apply = useMutation<{ data: ImportJob }, ApiError, string>({
    mutationFn: (id) => req(api.POST("/v1/imports/{id}/apply", { params: { path: { id } }, body: {} })),
    onSuccess: async (r) => {
      setJobId(r.data.id);
      await qc.invalidateQueries({ queryKey: keys.imports });
    },
  });

  const historyColumns: DataTableColumn<ImportJobSummary>[] = [
    { key: "created_at", header: "When", isRowHeader: true, render: (j) => <span className="tabular whitespace-nowrap">{dayClock(j.created_at)}</span> },
    {
      key: "kind",
      header: "Run",
      render: (j) =>
        j.dry_run ? (
          <Pill size="sm" tone="neutral">
            Dry run
          </Pill>
        ) : (
          <Pill size="sm" tone="paid">
            Apply
          </Pill>
        ),
    },
    { key: "status", header: "Status", render: (j) => statusDot(j) },
    { key: "files", header: "Files", render: (j) => <Quiet className="font-mono text-[12.5px]">{j.file_names.join(", ")}</Quiet> },
    { key: "summary", header: "Result", render: (j) => <span className="text-ink-2 tabular">{j.report ? summarise(j.report) : summariseCounts(j.report_summary) ?? j.error ?? "—"}</span> },
  ];

  return (
    <div className="grid gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-4 rounded-panel border border-rule bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="flex items-center gap-2 font-heading text-[16px] leading-[1.35] font-semibold text-ink">
            <Icon icon={Upload} size={16} className="text-ink-3" /> New import
          </h2>
          <span className="text-[13px] text-ink-3">Legacy POS importer · CSV</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileInput} type="file" accept=".csv,text/csv" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          <Button onPress={() => fileInput.current?.click()}>
            <Icon icon={Upload} size={16} /> Choose CSV files
          </Button>
          <span className="min-w-0 flex-1 basis-[240px] text-[13px] text-ink-2">One file per entity. Files are matched by legacy ID (or SKU, or mobile), so re-running is safe.</span>
        </div>
        <InlineError error={readError} />

        {uploads.map((u) => (
          <div key={u.name} className="flex flex-col gap-4 rounded-panel border border-rule-subtle bg-surface-2/40 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 font-mono text-[13px] text-ink [overflow-wrap:anywhere]">{u.name}</span>
              <span className="text-[12.5px] text-ink-3 tabular">
                {u.rows} {u.rows === 1 ? "row" : "rows"} · {u.headers.length} columns
              </span>
              <Select
                aria-label={`What ${u.name} contains`}
                variant="toolbar"
                selectedKey={u.entity}
                onSelectionChange={(k) => {
                  const entity = (k as ImportEntity | null) ?? null;
                  update(u.name, { entity, columns: entity ? autoMap(FIELDS[entity], u.headers) : {} });
                }}
                placeholder="What does this file contain?"
                items={ENTITY_ORDER.map((e) => ({ id: e, label: ENTITY_LABEL[e] }))}
              />
              <Button variant="quiet" iconOnly aria-label={`Remove ${u.name}`} className="ml-auto" onPress={() => setUploads((prev) => prev.filter((x) => x.name !== u.name))}>
                <Icon icon={X} size={16} />
              </Button>
            </div>
            {u.entity ? (
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {FIELDS[u.entity].map((f) => (
                  <div key={f.name} className="grid grid-cols-[minmax(120px,1fr)_minmax(140px,1.2fr)] items-center gap-3 py-1">
                    <span className="min-w-0">
                      <span className="font-mono text-[12.5px] text-ink">{f.name}</span>
                      {f.required ? <span className="ml-1 text-[12px] text-status-alert">required</span> : null}
                      {f.hint ? <span className="block truncate text-[12px] text-ink-3">{f.hint}</span> : null}
                    </span>
                    <Select
                      aria-label={`Column for ${f.name}`}
                      selectedKey={u.columns[f.name] ?? NONE}
                      onSelectionChange={(k) => {
                        const columns = { ...u.columns };
                        if (!k || k === NONE) delete columns[f.name];
                        else columns[f.name] = k;
                        update(u.name, { columns });
                      }}
                      isInvalid={f.required && !u.columns[f.name]}
                      items={[{ id: NONE, label: "Not mapped" }, ...u.headers.map((h) => ({ id: h, label: h }))]}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {uploads.length ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Brand legacy ID (option)" value={brandLegacyId} onChange={setBrandLegacyId} mono description="Used when a menus or layouts file has no brand column." />
              <TextField label="Outlet legacy ID (option)" value={outletLegacyId} onChange={setOutletLegacyId} mono description="Used when an areas file has no outlet column." />
            </div>
            <Warnings warnings={problems} tone="blocking" />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-ink-2">A dry run changes nothing. You read the report, then apply.</span>
              <Button variant="primary" isDisabled={problems.length > 0} isPending={dryRun.isPending} onPress={() => dryRun.mutate()}>
                Run a dry run on {uploads.length} {uploads.length === 1 ? "file" : "files"}
              </Button>
            </div>
            <InlineError error={dryRun.error} />
          </>
        ) : null}
        </div>

        {jobId ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel as="h2">Report</SectionLabel>
              {job.data ? <span className="font-mono text-[12px] text-ink-3">{jobId.slice(0, 8)}</span> : null}
            </div>
            {job.isPending ? <p className="text-ink-2">Loading the job…</p> : null}
            {job.data ? (
              <JobReport
                job={job.data}
                canApply={me.role === "admin"}
                onApply={() => apply.mutate(job.data!.id)}
                applying={apply.isPending}
                applyError={apply.error}
              />
            ) : null}
            <InlineError error={job.error} />
          </div>
        ) : null}
      </section>

      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <SectionLabel as="h2">History</SectionLabel>
          <span className="text-[12.5px] text-ink-3 tabular">{`${jobs.data.length} ${jobs.data.length === 1 ? "job" : "jobs"}`}</span>
        </div>
        <DataTable
          aria-label="Import jobs"
          columns={historyColumns}
          rows={jobs.data}
          rowKey={(j) => j.id}
          onRowAction={(j) => setJobId(j.id)}
          rowClassName={(j) => (j.id === jobId ? "bg-surface-2/60" : undefined)}
          emptyState={<EmptyState variant="centred" title="No imports yet" hint="Choose CSV files above to start a dry run." />}
        />
        <InlineError error={jobs.error} />
      </section>
    </div>
  );
}

/** The list endpoint carries `report_summary` (counts per entity) instead of the full report. */
function summariseCounts(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return null;
  let c = 0,
    u = 0,
    r = 0;
  for (const v of Object.values(summary as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as { creates?: number; updates?: number; rejected?: number | unknown[] };
    c += e.creates ?? 0;
    u += e.updates ?? 0;
    r += Array.isArray(e.rejected) ? e.rejected.length : (e.rejected ?? 0);
  }
  return `${c} new · ${u} updated · ${r} rejected`;
}

function summarise(report: ImportReport): string {
  let c = 0,
    u = 0,
    r = 0;
  for (const e of Object.values(report.entities)) {
    c += e.creates;
    u += e.updates;
    r += e.rejected.length;
  }
  return `${c} new · ${u} updated · ${r} rejected`;
}

function JobReport({ job, canApply, onApply, applying, applyError }: { job: ImportJob; canApply: boolean; onApply: () => void; applying: boolean; applyError: ApiError | null }) {
  const { dayClock } = useLocale();
  const [entityFilter, setEntityFilter] = useState<string>(ANY);
  const report = job.report;
  const entities = useMemo(() => (report ? ENTITY_ORDER.filter((e) => report.entities[e]) : []), [report]);
  const rejected = useMemo(() => {
    if (!report) return [];
    return entities.flatMap((e) => (report.entities[e]?.rejected ?? []).map((r, i) => ({ id: `${e}-${r.row}-${i}`, entity: e, ...r }))).filter((r) => entityFilter === ANY || r.entity === entityFilter);
  }, [report, entities, entityFilter]);

  const totals = entities.reduce(
    (acc, e) => {
      const x = report!.entities[e]!;
      return { creates: acc.creates + x.creates, updates: acc.updates + x.updates, unchanged: acc.unchanged + x.unchanged, rejected: acc.rejected + x.rejected.length };
    },
    { creates: 0, updates: 0, unchanged: 0, rejected: 0 },
  );

  const rejectedColumns: DataTableColumn<(typeof rejected)[number]>[] = [
    {
      key: "entity",
      header: "Entity",
      render: (r) => (
        <Pill size="sm" tone="neutral">
          {ENTITY_LABEL[r.entity]}
        </Pill>
      ),
    },
    { key: "row", header: "Row", numeric: true, render: (r) => r.row },
    { key: "reason", header: "Reason", render: (r) => <span className="text-ink break-words">{r.reason}</span> },
    {
      key: "data",
      header: "Data",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-2 break-words" title={JSON.stringify(r.data, null, 2)}>
          {Object.entries(r.data ?? {})
            .slice(0, 4)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join("  ")}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6 rounded-panel border border-rule bg-surface p-4">
      <DescriptionList
        layout="grid"
        items={[
          { term: "Status", detail: statusDot(job) },
          { term: "Run", detail: job.dry_run ? "Dry run: nothing was changed" : "Applied to the register" },
          { term: "Files", detail: job.file_names.join(", ") },
          { term: "Finished", detail: job.finished_at ? dayClock(job.finished_at) : "—" },
        ]}
      />
      {RUNNING.has(job.status) ? <p className="text-ink-2">The worker is processing the files. This page refreshes every few seconds.</p> : null}
      {job.error ? <InlineError error={{ message: job.error, remedy: "Fix the export or the mapping and run the dry run again." }} /> : null}

      {report ? (
        <>
          <div>
            <SectionLabel className="mb-2.5">Summary</SectionLabel>
            <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-panel bg-surface-2/60 px-4 py-3">
              <Stat label="New" value={totals.creates} tone="paid" />
              <Stat label="Updated" value={totals.updates} />
              <Stat label="Unchanged" value={totals.unchanged} />
              <Stat label="Rejected" value={totals.rejected} tone={totals.rejected ? "alert" : "default"} />
              <Stat label="Warnings" value={report.warnings.length} tone={report.warnings.length ? "alert" : "default"} />
            </div>
            <Group className="mt-3 overflow-x-auto">
            <table className="w-full text-[14px] leading-5">
              <thead>
                <tr className="text-left text-[12.5px] text-ink-3">
                  <th className="px-3 py-2 font-medium border-b border-rule-subtle">Entity</th>
                  <th className="px-3 py-2 text-right font-medium border-b border-rule-subtle">New</th>
                  <th className="px-3 py-2 text-right font-medium border-b border-rule-subtle">Updated</th>
                  <th className="px-3 py-2 text-right font-medium border-b border-rule-subtle">Unchanged</th>
                  <th className="px-3 py-2 text-right font-medium border-b border-rule-subtle">Rejected</th>
                </tr>
              </thead>
              <tbody>
                {entities.map((e) => {
                  const x = report.entities[e]!;
                  return (
                    <tr key={e} className="border-b border-rule-subtle tabular last:border-b-0">
                      <td className="px-3 py-2 text-ink">{ENTITY_LABEL[e]}</td>
                      <td className="px-3 py-2 text-right">{x.creates}</td>
                      <td className="px-3 py-2 text-right">{x.updates}</td>
                      <td className="px-3 py-2 text-right text-ink-2">{x.unchanged}</td>
                      <td className={`px-3 py-2 text-right ${x.rejected.length ? "text-status-alert" : "text-ink-2"}`}>{x.rejected.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </Group>
          </div>

          {report.warnings.length ? (
            <div>
              <SectionLabel className="mb-2.5">Warnings</SectionLabel>
              <Warnings warnings={report.warnings} />
            </div>
          ) : null}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <SectionLabel>Rejected rows</SectionLabel>
              <Select
                aria-label="Filter rejected rows by entity"
                variant="toolbar"
                selectedKey={entityFilter}
                onSelectionChange={(k) => setEntityFilter(k ?? ANY)}
                items={[{ id: ANY, label: "Every entity" }, ...entities.map((e) => ({ id: e, label: ENTITY_LABEL[e] }))]}
              />
            </div>
            <DataTable aria-label="Rejected rows" columns={rejectedColumns} rows={rejected} rowKey={(r) => r.id} emptyState={<EmptyState variant="centred" title="No rejected rows" hint="Every row was accepted." />} />
          </div>

          {job.dry_run && job.status === "dry_run_complete" ? (
            <div className="flex flex-wrap items-center gap-3 rounded-panel border border-rule bg-surface-2/40 px-4 py-3">
              <div className="min-w-0 flex-1 basis-[220px]">
                <p className="font-medium text-ink">Apply this import</p>
                <p className="text-[13px] text-ink-2">{canApply ? "Runs the same files and mapping for real. Rejected rows stay out." : "Only an Admin can apply an import."}</p>
              </div>
              <Button variant="primary" isDisabled={!canApply} isPending={applying} onPress={onApply}>
                Apply {totals.creates + totals.updates} {totals.creates + totals.updates === 1 ? "change" : "changes"}
              </Button>
              <InlineError error={applyError} className="basis-full" />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
