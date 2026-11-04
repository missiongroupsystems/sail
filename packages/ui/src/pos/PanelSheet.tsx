"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

export type PanelSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  /** A noun: the product's name, "Open item", "Search". */
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

/**
 * A sheet that slides in over one region only (design 4.3: the modifier sheet
 * covers the catalogue, never the order sheet). It is not modal: the rest of the
 * screen keeps working. Place it inside a `relative` container.
 */
export function PanelSheet({ isOpen, onClose, title, description, children, footer, className }: PanelSheetProps) {
  if (!isOpen) return null;
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label={typeof title === "string" ? title : undefined}
      className={cx("absolute inset-0 z-20 flex flex-col rounded-tile bg-surface shadow-sheet animate-sheet-in", className)}
    >
      <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 hairline-b">
        <div className="min-w-0 pt-1">
          <h2 className="truncate text-heading text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-body text-ink-2">{description}</p> : null}
        </div>
        <Button variant="quiet" size="lg" iconOnly aria-label="Close" onPress={onClose} className="-mr-2">
          <Icon icon={X} size={24} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 hairline-t">{footer}</footer> : null}
    </section>
  );
}
