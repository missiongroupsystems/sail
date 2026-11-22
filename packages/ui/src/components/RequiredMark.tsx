/**
 * After the label of a field that must be filled in: the word, in the label's own line, where an asterisk would need
 * a legend. Optional fields carry no mark. On a text field it is hidden from assistive technology, which hears
 * "required" from the input itself (`isRequired` sets `aria-required`), so the field's accessible name stays its label.
 * `announced`: for a control that cannot say it (a Select's trigger is a button, which takes no `aria-required`), the
 * mark is read as part of the label.
 */
export function RequiredMark({ announced = false }: { announced?: boolean }) {
  return (
    <span aria-hidden={announced ? undefined : "true"} data-required-mark className="font-normal text-ink-3">
      {" · Required"}
    </span>
  );
}
