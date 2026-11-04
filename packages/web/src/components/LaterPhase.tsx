import { PageHeader } from "@sail/ui";
import { SECTIONS } from "@/lib/nav";

/** A section from design 3.2 that this phase does not build yet. One quiet line; never a gap or a 404. */
export function LaterPhase({ href }: { href: string }) {
  const section = SECTIONS.find((s) => s.href === href);
  const label = section?.label ?? "This section";
  return (
    <>
      <PageHeader title={label} />
      <div className="flex max-w-[640px] flex-col gap-2">
        <p className="text-ink-2">
          {label} arrives in a later phase{section?.arrives ? ` (${section.arrives})` : ""}. Nothing is missing from today's data: this section does not exist yet.
        </p>
        {section?.summary ? <p className="text-ink-2">{section.summary}</p> : null}
      </div>
    </>
  );
}
