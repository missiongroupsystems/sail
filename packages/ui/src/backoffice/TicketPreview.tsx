import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type TicketPreviewProps = {
  /** The register's plain-text rendering of a print job, shown as it would print. */
  text: string;
  /** Paper width decides the column count: 48 for 80 mm, 32 for 58 mm (ESC/POS at Font A). */
  paperWidth?: "80mm" | "58mm";
  /** A quiet line above the paper: "Kitchen ticket · Grill · 7:42 pm". */
  caption?: ReactNode;
  className?: string;
};

/** A print job's plain text on a paper-coloured strip in monospace, for previews before a reprint or reroute. */
export function TicketPreview({ text, paperWidth = "80mm", caption, className }: TicketPreviewProps) {
  const cols = paperWidth === "58mm" ? 32 : 48;
  return (
    <figure className={cx("flex flex-col items-start gap-2", className)}>
      {caption ? <figcaption className="text-caption text-ink-2">{caption}</figcaption> : null}
      <pre
        className="max-w-full overflow-x-auto rounded-[4px] bg-white px-4 py-3 font-mono text-[13px] leading-[18px] text-black shadow-[0_1px_2px_rgba(0,0,0,0.18)] whitespace-pre"
        style={{ width: `calc(${cols}ch + 2rem)`, maxWidth: "100%" }}
      >
        {text || "(empty ticket)"}
      </pre>
    </figure>
  );
}
