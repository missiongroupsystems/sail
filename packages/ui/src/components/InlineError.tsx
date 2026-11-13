import { AlertTriangle } from "lucide-react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

/** The register's error shape (shared/errors.ts). Anything with a message fits. */
export type InlineErrorSource = { message: string; remedy?: string | null; code?: string } | string | null | undefined;

export type InlineErrorProps = {
  error: InlineErrorSource;
  className?: string;
};

/**
 * Says what happened and what to do, where the action was (7.8). Uses the API's
 * `remedy` verbatim. Never "Something went wrong".
 */
export function InlineError({ error, className }: InlineErrorProps) {
  if (!error) return null;
  const message = typeof error === "string" ? error : error.message;
  const remedy = typeof error === "string" ? null : error.remedy;
  return (
    <div role="alert" className={cx("flex items-start gap-2 rounded-field bg-status-alert-tint px-3 py-2.5 text-body", className)}>
      <Icon icon={AlertTriangle} size={18} className="mt-0.5 text-status-alert" />
      <div className="min-w-0">
        <p className="text-ink">{message}</p>
        {remedy ? <p className="text-ink-2">{remedy}</p> : null}
      </div>
    </div>
  );
}
