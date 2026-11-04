"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { Icon } from "./Icon";

export type SheetProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** A noun: "New outlet", "Mei Ting Tan". */
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Actions, primary last. Rendered in a fixed footer so Save is always reachable. */
  footer?: ReactNode;
  width?: "md" | "lg";
  /** Tap on the scrim or Escape closes it. Turn off while a save is in flight. */
  isDismissable?: boolean;
  className?: string;
};

const widths = { md: "sm:max-w-[520px]", lg: "sm:max-w-[760px]" } as const;

/**
 * The side sheet (7.6, 7.7): slides from the right over the content, 16pt
 * corners, one soft shadow and a 40% scrim. Used for create and edit forms in
 * the back office, and for modifier and line details on the POS.
 */
export function Sheet({ isOpen, onOpenChange, title, description, children, footer, width = "md", isDismissable = true, className }: SheetProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      className="fixed inset-0 z-50 flex justify-end bg-(--scrim) data-[entering]:animate-fade-in data-[exiting]:animate-fade-out"
    >
      <Modal
        className={cx(
          "h-full w-full bg-surface shadow-sheet outline-none sm:rounded-l-sheet",
          "data-[entering]:animate-sheet-in data-[exiting]:animate-sheet-out",
          widths[width],
          className,
        )}
      >
        <AriaDialog className="flex h-full flex-col outline-none">
          {({ close }) => (
            <>
              <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 hairline-b">
                <div className="min-w-0 pt-1.5">
                  <Heading slot="title" className="text-heading text-ink">
                    {title}
                  </Heading>
                  {description ? <p className="mt-0.5 text-body text-ink-2">{description}</p> : null}
                </div>
                <Button variant="quiet" iconOnly aria-label="Close" onPress={close} className="-mr-2">
                  <Icon icon={X} />
                </Button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
              {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 hairline-t">{footer}</footer> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
