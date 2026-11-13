"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { cx } from "../lib/cx";
import { useEdgeFade } from "../lib/use-edge-fade";
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
  /** "× Close" in words, as the POS sheets have it; otherwise a small × alone. */
  labelledClose?: boolean;
  className?: string;
};

const widths = { md: "sm:max-w-[540px]", lg: "sm:max-w-[760px]" } as const;

/**
 * The side sheet (7.6, 7.7): slides from the right over the content, 16pt
 * corners, one soft shadow and a 40% scrim. Used for create and edit forms in
 * the back office, and for modifier and line details on the POS.
 */
export function Sheet({ isOpen, onOpenChange, title, description, children, footer, width = "md", isDismissable = true, labelledClose = false, className }: SheetProps) {
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
          "h-full w-full overflow-hidden bg-surface shadow-sheet outline-none sm:my-2 sm:mr-2 sm:h-[calc(100%-16px)] sm:rounded-sheet",
          "data-[entering]:animate-sheet-in data-[exiting]:animate-sheet-out",
          widths[width],
          className,
        )}
      >
        <AriaDialog className="flex h-full flex-col outline-none">
          {({ close }) => (
            <>
              <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-rule-subtle">
                <div className="min-w-0 pt-2">
                  <Heading slot="title" className="font-heading text-[20px] leading-tight font-semibold tracking-[-0.01em] text-ink">
                    {title}
                  </Heading>
                  {description ? <p className="mt-0.5 text-body text-ink-2">{description}</p> : null}
                </div>
                {labelledClose ? (
                  <Button variant="quiet" size="md" onPress={close} className="-mr-2 gap-1.5 text-ink-2!">
                    <Icon icon={X} size={16} />
                    Close
                  </Button>
                ) : (
                  <Button variant="quiet" iconOnly aria-label="Close" onPress={close} className="-mr-2 text-ink-2!">
                    <Icon icon={X} size={16} />
                  </Button>
                )}
              </header>
              <SheetBody>{children}</SheetBody>
              {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-rule-subtle px-5 py-4 max-sm:px-4 max-sm:[&>button]:flex-1 max-sm:[&>button]:px-2.5 max-sm:[&>button]:text-[13.5px]">{footer}</footer> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The sheet's scrolling body: the bottom edge fades while there is more below the footer (notes under the choices). */
function SheetBody({ children }: { children: ReactNode }) {
  const { ref, onScroll, fadeClass } = useEdgeFade<HTMLDivElement>([], "y");
  return (
    <div ref={ref} onScroll={onScroll} className={cx("min-h-0 flex-1 overflow-y-auto px-5 py-5", fadeClass)}>
      {children}
    </div>
  );
}
