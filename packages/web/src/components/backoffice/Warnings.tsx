import { Icon, cx } from "@sail/ui";
import { AlertTriangle, Info } from "lucide-react";

/** Advisory lines the register returned with a successful write (`warnings: string[]`). Never hidden, never modal. */
export function Warnings({ warnings, className, tone = "advisory" }: { warnings: string[] | undefined | null; className?: string; tone?: "advisory" | "blocking" }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <ul className={cx("flex flex-col gap-1 rounded-tile px-3 py-2 text-body", tone === "blocking" ? "bg-[color-mix(in_srgb,var(--status-alert)_8%,transparent)]" : "bg-[color-mix(in_srgb,var(--status-sent)_10%,transparent)]", className)} role="status">
      {warnings.map((w, i) => (
        <li key={i} className="flex items-start gap-2">
          <Icon icon={tone === "blocking" ? AlertTriangle : Info} size={16} className={cx("mt-0.5", tone === "blocking" ? "text-status-alert" : "text-status-sent")} />
          <span className="text-ink">{w}</span>
        </li>
      ))}
    </ul>
  );
}
