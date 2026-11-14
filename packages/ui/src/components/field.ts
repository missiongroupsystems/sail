/** Shared field styling so every control reads as one grammar (principle 10). */
export const fieldLabel = "sail-field-label text-caption font-medium text-ink-2";
export const fieldDescription = "text-caption text-ink-3";
export const fieldError = "text-caption text-status-alert";
/**
 * On the POS: a grey fill with no resting border, a shade darker on hover and while focused. In the back office
 * (`data-scale="compact"`, or `data-surface="office"` on the page for sheets) the same control is a white field
 * with a 1px border (styles.css, `.sail-field`). Focus is the ink border alone, never a second ring. Invalid adds a red edge.
 */
const fieldControlBase =
  "sail-field w-full rounded-field border border-transparent bg-surface-2 text-ink placeholder:text-ink-3 outline-none " +
  "transition-colors duration-[120ms] " +
  "data-[hovered]:bg-surface-3 data-[focused]:border-ink data-[focused]:bg-surface-3 " +
  "data-[invalid]:border-status-alert data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-2 data-[disabled]:text-ink-disabled";
/** The 44px field (the default everywhere). */
export const fieldControl = `${fieldControlBase} min-h-11 px-3 text-body`;
/** The 36px back-office field for filter rows above a table (opt-in: `size="sm"`). Never on the POS. */
export const fieldControlSm = `${fieldControlBase} min-h-9 max-sm:min-h-11 px-2.5 text-[14px] leading-5`;
export type FieldSize = "md" | "sm";
export const fieldWrap = "flex flex-col gap-1.5";
