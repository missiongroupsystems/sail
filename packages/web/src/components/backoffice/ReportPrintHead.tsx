/** A report's title and scope at the top of its printed page; the screen has them in the header and the action row. */
export function ReportPrintHead({ title, scope }: { title: string; scope: [string, string][] }) {
  return (
    <div data-export="skip" className="col-span-full mb-6 hidden print:block">
      <h2 className="font-heading text-[16px] leading-[1.35] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <p className="text-[13.5px] leading-5 text-ink-2">{scope.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
    </div>
  );
}
