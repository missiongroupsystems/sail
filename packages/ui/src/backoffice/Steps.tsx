import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type Step = { id: string; label: ReactNode };

export type StepsProps = {
  steps: Step[];
  /** The id of the current step. Earlier steps read as done. */
  current: string;
  /** Lets a done step be tapped to go back; later steps are never tappable. */
  onStepPress?: (id: string) => void;
  className?: string;
};

/**
 * A short stepper's progress row: a
 * numbered dot and a label per step. Done steps show a tick; the current step is
 * ink; later steps are quiet. Keyboard-operable where going back is allowed.
 */
export function Steps({ steps, current, onStepPress, className }: StepsProps) {
  const currentIndex = Math.max(0, steps.findIndex((s) => s.id === current));
  return (
    <ol className={cx("flex flex-wrap items-center gap-x-2 gap-y-1", className)} aria-label="Steps">
      {steps.map((step, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        const dot = (
          <span
            aria-hidden
            className={cx(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-caption tabular",
              done && "bg-status-paid text-on-primary",
              active && "bg-primary text-on-primary",
              !done && !active && "bg-surface-2 text-ink-2",
            )}
          >
            {done ? <Icon icon={Check} size={13} strokeWidth={2.5} /> : i + 1}
          </span>
        );
        const label = <span className={cx("text-body", active ? "font-medium text-ink" : "text-ink-2")}>{step.label}</span>;
        return (
          <li key={step.id} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {done && onStepPress ? (
              <button type="button" onClick={() => onStepPress(step.id)} className="press flex min-h-11 items-center gap-2 rounded-field px-1.5 outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus">
                {dot}
                {label}
              </button>
            ) : (
              <span className="flex min-h-11 items-center gap-2 px-1">
                {dot}
                {label}
              </span>
            )}
            {i < steps.length - 1 ? <span aria-hidden className="h-px w-6 bg-rule" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
