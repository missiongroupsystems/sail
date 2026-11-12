import { Check, Circle, XCircle } from "lucide-react";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

/** Where a QR order is (design 4.11): Sent → Accepted → Preparing → Done, or not accepted. */
export type RoundStage = "sent" | "accepted" | "preparing" | "done" | "rejected";

const STEPS: { stage: Exclude<RoundStage, "rejected">; label: string }[] = [
  { stage: "sent", label: "Sent" },
  { stage: "accepted", label: "Accepted" },
  { stage: "preparing", label: "Preparing" },
  { stage: "done", label: "Done" },
];
const ORDER: Record<RoundStage, number> = { sent: 0, accepted: 1, preparing: 2, done: 3, rejected: 1 };

export type RoundTimelineProps = {
  stage: RoundStage;
  /** Staff's reason when the round was not accepted. */
  rejectReason?: string | null;
  /** With hold orders off the register accepts at once, so "Accepted" reads as "Received"; a round still waiting is this phone's first, held for staff. */
  holdOrders?: boolean;
  className?: string;
};

/** The round's progress as a vertical list; every step has a word, never colour alone (design 7.3). */
export function RoundTimeline({ stage, rejectReason, holdOrders = true, className }: RoundTimelineProps) {
  const reached = ORDER[stage];
  return (
    <ol aria-label="Order progress" className={cx("flex flex-col", className)}>
      {STEPS.map((s, i) => {
        const isRejectedStep = stage === "rejected" && i === 1;
        const done = stage !== "rejected" ? i < reached : i < 1;
        const current = stage !== "rejected" ? i === reached : isRejectedStep;
        const future = !done && !current;
        const label = isRejectedStep ? "Not accepted" : s.label === "Accepted" && !holdOrders ? "Received" : s.label;
        const skipped = stage === "rejected" && i > 1;
        return (
          <li key={s.stage} aria-current={current ? "step" : undefined} className={cx("relative flex min-h-12 items-start gap-3 py-1", skipped && "opacity-40")}>
            {i < STEPS.length - 1 ? <span aria-hidden className={cx("absolute left-[11px] top-8 h-[calc(100%-20px)] w-0.5", done ? "bg-brand-accent" : "bg-rule")} /> : null}
            <span
              aria-hidden
              className={cx(
                "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full",
                isRejectedStep ? "text-status-alert" : done ? "bg-brand-accent text-on-brand-accent" : current ? "bg-brand-accent text-on-brand-accent ring-4 ring-[color-mix(in_srgb,var(--brand-accent)_22%,transparent)]" : "text-rule",
              )}
            >
              {isRejectedStep ? <Icon icon={XCircle} size={24} /> : done || current ? <Icon icon={Check} size={14} strokeWidth={3} /> : <Icon icon={Circle} size={24} strokeWidth={1.5} />}
            </span>
            <span className="flex min-w-0 flex-col pt-0.5">
              <span className={cx("text-line", future ? "text-ink-2" : "text-ink", isRejectedStep && "text-status-alert")}>{label}</span>
              {isRejectedStep && rejectReason ? <span className="text-body text-ink-2">{rejectReason}</span> : null}
              {current && !isRejectedStep && stage === "sent" ? <span className="text-body text-ink-2">{holdOrders ? "Waiting for staff to accept it" : "Staff accept the first order from each phone. After that, this phone's orders go straight to the kitchen."}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
