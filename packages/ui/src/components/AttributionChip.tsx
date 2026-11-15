import { QrCode, Settings2 } from "lucide-react";
import { cx } from "../lib/cx";
import { AgentMark, Icon } from "./Icon";

export type Attribution =
  | { kind: "person"; initials: string; name?: string }
  | { kind: "assistant"; role?: string; forInitials?: string; forName?: string }
  | { kind: "guest"; label?: string }
  | { kind: "system"; label?: string };

export type AttributionChipProps = {
  who: Attribution;
  /** `compact` shows initials only (tables); `full` adds the name. */
  mode?: "compact" | "full";
  className?: string;
};

/** Derives up to three initials from a name: "Mei Ting Tan" → "MT" (first and last). */
export function initialsOf(name: string | null | undefined, fallback = "?"): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * Who did a committed thing: a person's initials, an assistant acting
 * for someone, a guest from a QR order, or the system. Agents are never people:
 * no faces, no first names.
 */
export function AttributionChip({ who, mode = "compact", className }: AttributionChipProps) {
  const chip = "inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-chip px-2 text-caption whitespace-nowrap";
  switch (who.kind) {
    case "person":
      return (
        <span className={cx("inline-flex items-center gap-2", className)} title={who.name}>
          <span className={cx(chip, "bg-surface-2 text-ink font-semibold")}>{who.initials}</span>
          {mode === "full" && who.name ? <span>{who.name}</span> : null}
        </span>
      );
    case "assistant": {
      const forWhom = who.forInitials ?? (who.forName ? initialsOf(who.forName) : null);
      return (
        <span className={cx(chip, "bg-agent-tint font-medium text-agent", className)} title={who.forName ? `Assistant · for ${who.forName}` : "Assistant"}>
          <AgentMark size={11} />
          <span>{who.role ?? "Assistant"}</span>
          {forWhom ? <span className="text-agent/80">· for {mode === "full" && who.forName ? who.forName : forWhom}</span> : null}
        </span>
      );
    }
    case "guest":
      return (
        <span className={cx(chip, "bg-surface-2 font-medium text-ink-2", className)}>
          <Icon icon={QrCode} size={12} />
          <span>{who.label ?? "Guest"}</span>
        </span>
      );
    case "system":
      return (
        <span className={cx(chip, "bg-surface-2 font-medium text-ink-2", className)}>
          <Icon icon={Settings2} size={12} />
          <span>{who.label ?? "System"}</span>
        </span>
      );
  }
}
