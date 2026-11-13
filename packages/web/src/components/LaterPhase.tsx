import { AgentMark, PageHeader } from "@sail/ui";
import { SECTIONS } from "@/lib/nav";

/** A section that this phase does not build yet. A quiet card with the agent mark; never a gap or a 404. */
export function LaterPhase({ href }: { href: string }) {
  const section = SECTIONS.find((s) => s.href === href);
  const label = section?.label ?? "This section";
  return (
    <>
      <PageHeader title={label} description={section?.summary} />
      <div className="flex max-w-[720px] flex-col items-center gap-3 rounded-[14px] border border-rule bg-surface px-6 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-agent-tint text-agent" aria-hidden>
          <AgentMark size={18} />
        </span>
        <p className="max-w-[52ch] text-[15px] leading-[22px] text-ink-2">
          {label} arrives in a later phase{section?.arrives ? ` (${section.arrives})` : ""}. Nothing is missing from today's data: this section does not exist yet.
        </p>
      </div>
    </>
  );
}
