"use client";

import { AlertTriangle, Check, Clock } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Money } from "../components/Money";

export type LineRowStatus = "new" | "held" | "sent" | "voided" | "pending";

export type LineRowProps = {
  quantity: number;
  name: string;
  /** Modifier names, indented one level in secondary text. */
  modifiers?: string[];
  /** Kitchen note, in italics. */
  notes?: string | null;
  seat?: number | null;
  /** Register amount in cents; `null` while the line is optimistic and the register has not priced it. */
  amountCents: number | null;
  status: LineRowStatus;
  /** Reason on removed or voided lines. */
  voidReason?: string | null;
  /** Highlight once (400 ms) when the register changed this row's amount. */
  flash?: boolean;
  /** Slide in on first render (new line). */
  entering?: boolean;
  /** Print status of a sent line: ✓ printed, ◷ waiting, ⚠ not printed. Omit for the plain "sent" mark. */
  printStatus?: "printed" | "waiting" | "late" | null;
  /** A sent line the kitchen display has bumped: "ready" in place of the print status. */
  ready?: boolean;
  /** A small source chip after the name, for example "QR" on guest lines. */
  chip?: string | null;
  onPress?: () => void;
  className?: string;
};

const PRINT_STATUS = {
  printed: { icon: Check, text: "printed", cls: "text-ink-2" },
  waiting: { icon: Clock, text: "waiting", cls: "text-ink-2" },
  late: { icon: AlertTriangle, text: "not printed", cls: "text-status-alert" },
} as const;
const READY = { icon: Check, text: "ready", cls: "text-status-paid" } as const;

/** An order line: quantity, name, modifiers, notes, seat chip, amount in tabular figures. */
export function LineRow({ quantity, name, modifiers = [], notes, seat, amountCents, status, voidReason, flash, entering, printStatus, ready, chip, onPress, className }: LineRowProps) {
  const voided = status === "voided";
  const print = status === "sent" && ready ? READY : status === "sent" && printStatus ? PRINT_STATUS[printStatus] : null;
  const body = (
    <>
      <span className={cx("w-7 shrink-0 pt-px text-line tabular", voided ? "text-ink-2 line-through" : "text-ink")}>{quantity}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("flex items-center gap-2 text-line", voided && "text-ink-2 line-through")}>
          <span className="truncate">{name}</span>
          {seat != null ? <span className="shrink-0 rounded-chip bg-surface-2 px-2 text-caption text-ink-2 tabular">S{seat}</span> : null}
          {chip ? <span className="shrink-0 rounded-chip bg-[color-mix(in_srgb,var(--status-seated)_12%,transparent)] px-2 text-caption text-status-seated">{chip}</span> : null}
          {status === "held" ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-caption text-status-sent">
              <Icon icon={Clock} size={14} /> Held
            </span>
          ) : null}
        </span>
        {modifiers.map((m, i) => (
          <span key={i} className="block truncate pl-3 text-body text-ink-2">
            · {m}
          </span>
        ))}
        {notes ? <span className="block truncate pl-3 text-body text-ink-2 italic">{notes}</span> : null}
        {voided && voidReason ? <span className="block truncate pl-3 text-caption text-ink-2">Removed · {voidReason}</span> : null}
      </span>
      <span className="shrink-0 pt-px text-right">
        {status === "pending" || amountCents == null ? (
          <span className="text-caption text-ink-2 italic" aria-live="polite">
            pricing
          </span>
        ) : (
          <Money cents={amountCents} size="line" className={voided ? "text-ink-2 line-through" : "text-ink"} />
        )}
        {print ? (
          <span className={cx("mt-0.5 flex items-center justify-end gap-1 text-caption", print.cls)}>
            <Icon icon={print.icon} size={14} /> {print.text}
          </span>
        ) : status === "sent" ? (
          <span className="mt-0.5 flex items-center justify-end gap-1 text-caption text-ink-2">
            <Icon icon={Check} size={14} /> sent
          </span>
        ) : null}
      </span>
    </>
  );
  const classes = cx(
    "flex w-full items-start gap-2 rounded-tile px-3 py-2.5 text-left outline-none",
    flash && "pos-flash keep-motion",
    entering && "pos-line-in",
    onPress && "press pos-touch data-[pressed]:bg-surface-2 data-[hovered]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-status-seated",
    className,
  );
  if (!onPress) return <div className={classes}>{body}</div>;
  return (
    <AriaButton onPress={onPress} className={classes} aria-label={`${quantity} ${name}${chip ? `, ${chip}` : ""}${status === "sent" ? (print ? `, ${print.text}` : ", sent") : status === "held" ? ", held" : ""}`}>
      {body}
    </AriaButton>
  );
}

export type GroupHeaderProps = {
  /** NEW, HELD, or "SENT 7:42 · round 1". */
  label: string;
  detail?: string;
  action?: { label: string; onPress: () => void; isDisabled?: boolean };
  className?: string;
};

/** A state group header in the order sheet (NEW / HELD / SENT rounds). */
export function GroupHeader({ label, detail, action, className }: GroupHeaderProps) {
  return (
    <div className={cx("flex min-h-9 items-center justify-between gap-2 px-3 pt-3 pb-1", className)}>
      <span className="text-caption text-ink-2 uppercase tracking-[0.04em]">
        {label}
        {detail ? <span className="normal-case tracking-normal"> · {detail}</span> : null}
      </span>
      {action ? (
        <AriaButton onPress={action.onPress} isDisabled={action.isDisabled} className="press pos-touch min-h-9 rounded-chip px-3 text-caption text-ink outline-none data-[pressed]:bg-surface-2 data-[hovered]:bg-surface-2 data-[disabled]:opacity-45">
          {action.label}
        </AriaButton>
      ) : null}
    </div>
  );
}
