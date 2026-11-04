"use client";

import type { ReactNode } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { cx } from "../lib/cx";

export type DialogProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: ReactNode;
  children?: ReactNode;
  /** Actions, primary last. Labels state the effect: "Archive outlet", never "OK". */
  footer?: ReactNode;
  isDismissable?: boolean;
  role?: "dialog" | "alertdialog";
  className?: string;
};

/**
 * Back office only (design 2.2: on the POS, modals are reserved for PIN entry).
 * Never used for "Are you sure?" on routine or consequential actions; a labelled
 * button and Undo do that job.
 */
export function Dialog({ isOpen, onOpenChange, title, children, footer, isDismissable = true, role = "dialog", className }: DialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim) p-4 data-[entering]:animate-fade-in data-[exiting]:animate-fade-out"
    >
      <Modal
        className={cx(
          "w-full max-w-[480px] rounded-sheet bg-surface shadow-sheet outline-none data-[entering]:animate-rise-in data-[exiting]:animate-rise-out",
          className,
        )}
      >
        <AriaDialog role={role} className="flex flex-col outline-none">
          <Heading slot="title" className="px-6 pt-6 text-heading text-ink">
            {title}
          </Heading>
          {children ? <div className="px-6 pt-2 pb-2 text-body text-ink-2">{children}</div> : null}
          {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 px-6 py-5">{footer}</footer> : <div className="pb-6" />}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
