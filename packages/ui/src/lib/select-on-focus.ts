import type { FocusEvent } from "react";

/** A later tap this long after focus is the person placing the caret on purpose; the tap that focused comes sooner. */
const DELIBERATE_TAP_MS = 500;

/**
 * Typing into a prefilled number field replaces its value instead of adding to it ("2" on a count of 1 became "21",
 * review 2 N9 and review 3 S4). The value is selected when the field takes focus, a frame later because WebKit drops a
 * selection made inside the focus event. A tap on a touch screen can still put a caret back after that selection
 * (Chromium and WebKit both do), so the first character typed after focus replaces the whole value whatever the
 * selection is. A deliberate tap or arrow key after focus, or a delete, ends that and edits as usual.
 */
export function selectOnFocus(e: FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget;
  const focusedAt = Date.now();
  let ended = false;
  requestAnimationFrame(() => {
    // Not once the person has typed: selecting then would make the next key replace the first.
    if (!ended && document.activeElement === el) el.select();
  });
  const done = () => {
    ended = true;
    el.removeEventListener("beforeinput", onBeforeInput);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("blur", done);
  };
  const onBeforeInput = (ev: InputEvent) => {
    done();
    if (ev.inputType !== "insertText" || !ev.data || !el.value) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    // Part of the value chosen by hand: the browser replaces just that.
    if (start !== end && !(start === 0 && end === el.value.length)) return;
    ev.preventDefault();
    replaceValue(el, ev.data);
  };
  const onPointerDown = () => {
    if (Date.now() - focusedAt > DELIBERATE_TAP_MS) done();
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key.startsWith("Arrow") || ev.key === "Home" || ev.key === "End") done();
  };
  el.addEventListener("beforeinput", onBeforeInput);
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("blur", done);
}

/** Set the field's value as typing would, so React (and React Aria) see an ordinary change. */
function replaceValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
