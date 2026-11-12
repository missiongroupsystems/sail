/** Shared field styling so every control reads as one grammar (principle 10). */
export const fieldLabel = "text-caption text-ink-2";
export const fieldDescription = "text-caption text-ink-2";
export const fieldError = "text-caption text-status-alert";
export const fieldControl =
  "w-full min-h-11 rounded-tile bg-surface hairline px-3 text-body text-ink placeholder:text-ink-2/70 outline-none " +
  "transition-[border-color,box-shadow] duration-[80ms] " +
  "data-[focused]:border-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated " +
  "data-[invalid]:border-status-alert data-[disabled]:opacity-50 data-[hovered]:border-ink-2";
export const fieldWrap = "flex flex-col gap-1.5";
