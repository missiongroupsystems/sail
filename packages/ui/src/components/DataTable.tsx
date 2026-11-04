"use client";

import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
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
  className?: string;
};

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
};

function compare(a: SortValue, b: SortValue): number {
  const aNil = a === null || a === undefined || a === "";
  const bNil = b === null || b === undefined || b === "";
  if (aNil && bNil) return 0;
  if (aNil) return 1;
  if (bNil) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

/**
 * A sortable, keyboard-operable table for the back office. Rows are hairline
 * separated; headers are quiet; numbers are tabular. Virtualisation is a
 * follow-up for the 20,000-row cases (TanStack Virtual, design 11.1).
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
  ...rest
}: DataTableProps<RowT>) {
  const [internalSort, setInternalSort] = useState<DataTableSort | undefined>(defaultSort);
  const activeSort = sort ?? internalSort;

  const sorted = useMemo(() => {
    if (!activeSort) return rows;
    const col = columns.find((c) => c.key === activeSort.column);
    if (!col) return rows;
    const getter = col.sortValue ?? ((row: RowT) => (row as Record<string, unknown>)[col.key] as SortValue);
    const dir = activeSort.direction === "ascending" ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index, value: getter(row) }))
      .sort((x, y) => compare(x.value, y.value) * dir || x.index - y.index)
      .map((x) => x.row);
  }, [rows, columns, activeSort]);

  const byKey = useMemo(() => new Map(sorted.map((row) => [rowKey(row), row] as const)), [sorted, rowKey]);
  const hasRowHeader = columns.some((c) => c.isRowHeader);

  const sortDescriptor: SortDescriptor | undefined = activeSort ? { column: activeSort.column, direction: activeSort.direction } : undefined;
  const handleSort = (d: SortDescriptor) => {
    const next: DataTableSort = { column: String(d.column), direction: d.direction ?? "ascending" };
    if (onSortChange) onSortChange(next);
    else setInternalSort(next);
  };

  return (
    <div className={cx("w-full overflow-x-auto", className)}>
      <Table
        aria-label={rest["aria-label"]}
        sortDescriptor={sortDescriptor}
        onSortChange={handleSort}
        onRowAction={onRowAction ? (key: Key) => {
          const row = byKey.get(String(key));
          if (row) onRowAction(row);
        } : undefined}
        selectionMode="none"
        className="w-full border-collapse text-body"
      >
        <TableHeader className={cx(stickyHeader && "sticky top-0 z-10 bg-bg")}>
          {columns.map((col, i) => (
            <Column
              key={col.key}
              id={col.key}
              isRowHeader={col.isRowHeader ?? (!hasRowHeader && i === 0)}
              allowsSorting={col.sortable}
              width={col.width}
              className={cx(
                "hairline-b px-3 py-2 text-caption text-ink-2 font-medium whitespace-nowrap outline-none select-none",
                col.align === "end" || col.numeric ? "text-right" : "text-left",
                col.sortable && "cursor-default data-[hovered]:text-ink",
                "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-status-seated",
              )}
            >
              {({ sortDirection, allowsSorting }) => (
                <span className={cx("inline-flex items-center gap-1", (col.align === "end" || col.numeric) && "flex-row-reverse")}>
                  <span>{col.header}</span>
                  {allowsSorting ? (
                    <Icon
                      icon={sortDirection === "ascending" ? ChevronUp : sortDirection === "descending" ? ChevronDown : ChevronsUpDown}
                      size={14}
                      className={cx(!sortDirection && "opacity-50")}
                    />
                  ) : null}
                </span>
              )}
            </Column>
          ))}
        </TableHeader>
        <TableBody
          items={isLoading ? [] : sorted}
          renderEmptyState={() =>
            isLoading ? (
              <div className="px-3 py-4">
                <Skeleton lines={4} />
              </div>
            ) : (
              <div className="px-3 py-6 text-body text-ink-2">{emptyState ?? "Nothing here yet."}</div>
            )
          }
        >
          {(row) => (
            <Row
              id={rowKey(row)}
              className={cx(
                "group hairline-b outline-none",
                onRowAction && "cursor-default data-[hovered]:bg-surface-2/60 data-[pressed]:bg-surface-2",
                "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-status-seated",
                rowClassName?.(row),
              )}
            >
              {columns.map((col) => (
                <Cell
                  key={col.key}
                  className={cx(
                    "min-h-11 px-3 py-2.5 align-middle text-ink outline-none",
                    (col.align === "end" || col.numeric) && "text-right",
                    col.numeric && "tabular",
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
  );
}
