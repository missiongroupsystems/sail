"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton, Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type BottomSheetProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** A noun: the item's name, "Call staff". */
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** The one primary action, in a fixed footer so it is always reachable. */
  footer?: ReactNode;
  /** Tap on the scrim or Escape closes it. Turn off while a send is in flight. */
  isDismissable?: boolean;
  className?: string;
};

/**
 * The guest sheet (design 7.6, 7.7): slides up from the bottom of the phone,
 * 16px top corners, one soft shadow and a 40% scrim. React Aria moves focus
 * into the dialog on open and back to the trigger on close (section 10).
 */
export function BottomSheet({ isOpen, onOpenChange, title, description, children, footer, isDismissable = true, className }: BottomSheetProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      className="fixed inset-0 z-50 flex items-end justify-center bg-(--scrim) data-[entering]:animate-fade-in data-[exiting]:animate-fade-out"
    >
      <Modal
        className={cx(
          "relative flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-sheet bg-surface shadow-sheet outline-none",
          "data-[entering]:animate-sheet-up data-[exiting]:animate-sheet-down",
          className,
        )}
      >
        <AriaDialog className="flex min-h-0 flex-1 flex-col outline-none">
          {({ close }) => (
            <>
              <span aria-hidden className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-rule" />
              <header className="flex items-start justify-between gap-3 px-4 pt-5 pb-3 hairline-b">
                <div className="min-w-0 pt-1">
                  <Heading slot="title" className="font-display text-title text-ink">
                    {title}
                  </Heading>
                  {description ? <p className="mt-1 text-body text-ink-2">{description}</p> : null}
                </div>
                <AriaButton
                  onPress={close}
                  aria-label="Close"
                  className="press -mr-2 flex size-12 shrink-0 items-center justify-center rounded-tile text-ink outline-none data-[pressed]:scale-[0.97] data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated"
                >
                  <Icon icon={X} size={22} />
                </AriaButton>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
              {footer ? <footer className="flex flex-col gap-2 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] hairline-t">{footer}</footer> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
