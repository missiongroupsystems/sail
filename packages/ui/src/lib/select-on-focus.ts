import type { FocusEvent } from "react";

/**
 * Select a field's whole value when it takes focus, so typing replaces a prefilled "0" or amount instead of adding to
 * it ("2" became "20" on the drawer count, review 2 N9). Selected a frame later: WebKit drops a selection made inside
 * the focus event when the tap that focused the field ends.
 */
export function selectOnFocus(e: FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget;
  requestAnimationFrame(() => {
    if (document.activeElement === el) el.select();
  });
}
