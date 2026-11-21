/**
 * After the label of a field that must be filled in: the word, in the label's own line, where an asterisk would need
 * a legend. Optional fields carry no mark. It is hidden from assistive technology, which hears "required" from the
 * control itself (`isRequired` sets `aria-required`), so the field's accessible name stays its label.
 */
export function RequiredMark() {
  return (
    <span aria-hidden="true" data-required-mark className="font-normal text-ink-3">
      {" · Required"}
    </span>
  );
}
