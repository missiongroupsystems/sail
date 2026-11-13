"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
  type ColumnProps,
  type Key,
  type SortDescriptor,
} from "react-aria-components";
import { cx } from "../lib/cx";
import { useLocale } from "../lib/locale";
import { useHydrated } from "../lib/use-hydrated";
import { useEdgeFade } from "../lib/use-edge-fade";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { Skeleton } from "./Skeleton";

export type SortValue = string | number | boolean | null | undefined;

export type DataTableColumn<RowT> = {
  /** Stable key; also the default sort field when `sortValue` is omitted and the row has this property. */
  key: string;
  header: ReactNode;
  render: (row: RowT) => ReactNode;
  sortable?: boolean;
  sortValue?: (row: RowT) => SortValue;
  align?: "start" | "end";
  /** Column width: a pixel number, "20%" or "2fr". */
  width?: ColumnProps["width"];
  /** Marks the column whose cell names the row for screen readers (default: first column). */
  isRowHeader?: boolean;
  /** Tabular figures and right alignment for numbers. */
  numeric?: boolean;
  /** A secondary column left out on narrower screens, so the key ones fit without scrolling (`xl`: below 1280px). */
  hideBelow?: "lg" | "xl";
  className?: string;
};

const HIDE_BELOW = { lg: "max-lg:hidden", xl: "max-xl:hidden" } as const;

export type DataTableSort = { column: string; direction: "ascending" | "descending" };

export type DataTableProps<RowT> = {
  columns: DataTableColumn<RowT>[];
  rows: RowT[];
  rowKey: (row: RowT) => string;
  "aria-label": string;
  /** Tapping a row opens it (a sheet, a drawer). Rows show a hover state when set. */
  onRowAction?: (row: RowT) => void;
  defaultSort?: DataTableSort;
  /** Controlled sort; use with `onSortChange`. */
  sort?: DataTableSort;
  onSortChange?: (sort: DataTableSort) => void;
  /** Shown inside the table when there are no rows. */
  emptyState?: ReactNode;
  /** First load only: rows are not known yet. */
  isLoading?: boolean;
  /** A row-level treatment, e.g. muted for archived rows. */
  rowClassName?: (row: RowT) => string | undefined;
  className?: string;
  /** Lets a long table keep its header visible inside a scrolling parent. */
  stickyHeader?: boolean;
  /**
   * `true` (default) runs the table edge to edge on the page sheet: it bleeds into the page's side
   * padding and insets its outer cells, so the first column lines up with the page title. Pass
   * `false` for a table inside a sheet with its own padding, or `"inset"` for a table that fills a
   * bordered panel edge to edge (outer cells inset 20px, no bleed).
   */
  flush?: boolean | "inset";
};

/** Text sorts in the merchant's locale, not the runtime's default, so the server render and the browser agree. */
function compare(a: SortValue, b: SortValue, locale: string): number {
  const aNil = a === null || a === undefined || a === "";
  const bNil = b === null || b === undefined || b === "";
  if (aNil && bNil) return 0;
  if (aNil) return 1;
  if (bNil) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), locale, { sensitivity: "base", numeric: true });
}

/**
 * A sortable, keyboard-operable table for the back office. Rows are hairline
 * separated; headers are quiet; numbers are tabular. Virtualisation is a
 * follow-up for the 20,000-row cases (TanStack Virtual).
 */
export function DataTable<RowT>({
  columns,
  rows,
  rowKey,
  onRowAction,
  defaultSort,
  sort,
  onSortChange,
  emptyState,
  isLoading,
  rowClassName,
  className,
  stickyHeader,
  flush = true,
  ...rest
}: DataTableProps<RowT>) {
  const [internalSort, setInternalSort] = useState<DataTableSort | undefined>(defaultSort);
  const activeSort = sort ?? internalSort;
  const { locale } = useLocale();
  // Rows the server rendered can be seen before React attaches their press handlers; until then they say they are not
  // interactive (a disabled group around the table), so assistive technology and test drivers wait instead of pressing nothing.
  const hydrated = useHydrated();
  const { ref: scroller, onScroll, fadeClass } = useEdgeFade<HTMLDivElement>([rows.length, columns.length]);

  const sorted = useMemo(() => {
    if (!activeSort) return rows;
    const col = columns.find((c) => c.key === activeSort.column);
    if (!col) return rows;
    const getter = col.sortValue ?? ((row: RowT) => (row as Record<string, unknown>)[col.key] as SortValue);
    const dir = activeSort.direction === "ascending" ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index, value: getter(row) }))
      .sort((x, y) => compare(x.value, y.value, locale) * dir || x.index - y.index)
      .map((x) => x.row);
  }, [rows, columns, activeSort, locale]);

  const byKey = useMemo(() => new Map(sorted.map((row) => [rowKey(row), row] as const)), [sorted, rowKey]);
  const hasRowHeader = columns.some((c) => c.isRowHeader);

  const sortDescriptor: SortDescriptor | undefined = activeSort ? { column: activeSort.column, direction: activeSort.direction } : undefined;
  const handleSort = (d: SortDescriptor) => {
    const next: DataTableSort = { column: String(d.column), direction: d.direction ?? "ascending" };
    if (onSortChange) onSortChange(next);
    else setInternalSort(next);
  };

  return (
    <>
    {/* A table never squeezes its columns into ribbons on a phone: it keeps a width per column and scrolls sideways
        inside its frame, with the edge faded where more columns sit beyond it. */}
    <div ref={scroller} onScroll={onScroll} role={onRowAction && !hydrated ? "group" : undefined} aria-disabled={onRowAction && !hydrated ? true : undefined} className={cx("overflow-x-auto", fadeClass, flush === true ? "-mx-4 sm:-mx-5" : "w-full", className)}>
      <Table
        aria-label={rest["aria-label"]}
        sortDescriptor={sortDescriptor}
        onSortChange={handleSort}
        onRowAction={onRowAction ? (key: Key) => {
          const row = byKey.get(String(key));
          if (row) onRowAction(row);
        } : undefined}
        selectionMode="none"
        style={{ "--table-min": `${columns.length * 8}rem` } as React.CSSProperties}
        className={cx(
          // On a phone only: each column keeps 8rem and the table scrolls; wider screens lay out as before.
          "w-full border-collapse text-[14px] leading-5 max-sm:min-w-(--table-min)",
          flush === true && "[&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4 sm:[&_tr>*:first-child]:pl-5 sm:[&_tr>*:last-child]:pr-5",
          flush === "inset" && "[&_tr>*:first-child]:pl-5 [&_tr>*:last-child]:pr-5",
        )}
      >
        <TableHeader className={cx(stickyHeader && "sticky top-0 z-10 bg-surface")}>
          {columns.map((col, i) => (
            <Column
              key={col.key}
              id={col.key}
              isRowHeader={col.isRowHeader ?? (!hasRowHeader && i === 0)}
              allowsSorting={col.sortable}
              width={col.width}
              className={cx(
                "h-10 border-b border-rule px-3 py-2 text-[14px] leading-5 font-bold text-ink-2 whitespace-nowrap outline-none select-none",
                col.align === "end" || col.numeric ? "text-right" : "text-left",
                col.sortable && "cursor-default data-[hovered]:text-ink",
                col.hideBelow && HIDE_BELOW[col.hideBelow],
                "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-focus",
              )}
            >
              {({ sortDirection, allowsSorting }) => (
                // The chevron follows the label and shows only on the sorted column, as on the rest of the office.
                <span className="inline-flex items-center gap-1">
                  <span>{col.header}</span>
                  {allowsSorting && sortDirection ? <Icon icon={sortDirection === "ascending" ? ChevronUp : ChevronDown} size={14} /> : null}
                </span>
              )}
            </Column>
          ))}
        </TableHeader>
        <TableBody
          items={isLoading ? [] : sorted}
          // React Aria keeps each row's render until its item changes; a column that reads data arriving later (a
          // product's name looked up by id) must redraw the rows when the columns change.
          dependencies={[columns]}
          renderEmptyState={() =>
            isLoading ? (
              <div className="px-3 py-4">
                <Skeleton lines={4} />
              </div>
            ) : (
              // Drawn under the table instead (below), where it keeps to the screen's width on a phone.
              <span className="sr-only">No rows</span>
            )
          }
        >
          {(row) => (
            <Row
              id={rowKey(row)}
              className={cx(
                "group outline-none transition-colors duration-[120ms]",
                onRowAction && "cursor-default data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-3",
                "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-focus",
                rowClassName?.(row),
              )}
            >
              {columns.map((col, i) => (
                <Cell
                  key={col.key}
                  className={cx(
                    "h-11 px-3 py-3 align-middle text-ink outline-none",
                    // The cell that names the row and the figures never break mid-word; a narrow screen scrolls the table instead.
                    (col.isRowHeader ?? (!hasRowHeader && i === 0)) && "whitespace-nowrap",
                    (col.align === "end" || col.numeric) && "text-right whitespace-nowrap",
                    col.numeric && "tabular",
                    col.hideBelow && HIDE_BELOW[col.hideBelow],
                    col.className,
                  )}
                >
                  {col.render(row)}
                </Cell>
              ))}
            </Row>
          )}
        </TableBody>
      </Table>
    </div>
    {!isLoading && rows.length === 0 ? typeof emptyState === "string" || emptyState === undefined ? <EmptyState variant="centred" title={emptyState ?? "Nothing here yet."} /> : emptyState : null}
    </>
  );
}
