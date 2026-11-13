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
 * The guest sheet: slides up from the bottom of the phone with a grabber,
 * 24px top corners, a title that wraps, a 44px close control, a body that
 * scrolls on its own and a footer that stays under the thumb. React Aria moves focus
 * into the dialog on open and back to the trigger on close (section 10).
 */
export function BottomSheet({ isOpen, onOpenChange, title, description, children, footer, isDismissable = true, className }: BottomSheetProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      className="fixed inset-0 z-50 flex items-end justify-center bg-(--scrim) backdrop-blur-[3px] data-[entering]:animate-fade-in data-[exiting]:animate-fade-out"
    >
      <Modal
        className={cx(
          "relative flex max-h-[92dvh] w-full max-w-[480px] flex-col rounded-t-3xl bg-surface shadow-sheet outline-none",
          "data-[entering]:animate-sheet-up data-[exiting]:animate-sheet-down",
          className,
        )}
      >
        <AriaDialog className="flex min-h-0 flex-1 flex-col outline-none">
          {({ close }) => (
            <>
              <span aria-hidden className="mt-2 h-[5px] w-9 shrink-0 self-center rounded-[3px] bg-surface-3" />
              <header className="flex items-start justify-between gap-3 py-2 pr-2 pl-5">
                <div className="flex min-w-0 flex-col gap-1 py-2">
                  <Heading slot="title" className="font-display text-[20px] leading-snug font-semibold tracking-tight text-balance text-ink wrap-anywhere">
                    {title}
                  </Heading>
                  {description ? <div className="text-[14.5px] text-ink-2">{description}</div> : null}
                </div>
                <AriaButton
                  onPress={close}
                  aria-label="Close"
                  className="press flex size-11 shrink-0 items-center justify-center rounded-full text-ink-2 outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
                >
                  <Icon icon={X} size={20} />
                </AriaButton>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-5 text-[15px]">{children}</div>
              {footer ? <footer className="flex shrink-0 flex-col gap-2 border-t border-rule-subtle px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">{footer}</footer> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
