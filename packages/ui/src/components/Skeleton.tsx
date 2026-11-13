import { cx } from "../lib/cx";

export type SkeletonProps = {
  className?: string;
  /** Rows of text to imitate; omit for a single block sized by className. */
  lines?: number;
  /** Appear only after a first load has taken this long (7.8: 300 ms). */
  delayMs?: number;
};

/** A quiet placeholder for first loads. Keep showing the last known state whenever one exists. */
export function Skeleton({ className, lines, delayMs = 300 }: SkeletonProps) {
  const style = { animationDelay: `${delayMs}ms` } as const;
  if (lines && lines > 1) {
    return (
      <div className={cx("flex flex-col gap-2", className)} aria-busy="true" aria-live="polite">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={cx("h-3 rounded-[5px] bg-surface-3 opacity-0 animate-skeleton [animation-fill-mode:both]", i === lines - 1 && "w-2/3")} style={style} />
        ))}
      </div>
    );
  }
  return <div className={cx("h-3 rounded-[5px] bg-surface-3 opacity-0 animate-skeleton [animation-fill-mode:both]", className)} style={style} aria-busy="true" />;
}
