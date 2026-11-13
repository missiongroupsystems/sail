/**
 * Station class strings shared by the POS screens.
 *
 * `GREY_PILL` turns a quiet `Button` into the grey-fill secondary pill that sits left of a screen's one ink pill.
 * The `!` wins over the quiet variant's transparent fill, since `cx` joins classes without merging.
 */
export const GREY_PILL = "bg-surface-2! data-[hovered]:bg-surface-3! data-[pressed]:bg-surface-3! data-[disabled]:bg-transparent! data-[disabled]:shadow-[inset_0_0_0_1px_var(--line)]";

/** A white panel floating on the sunken canvas: 14pt corners, a hairline, no shadow. */
export const PANEL = "rounded-panel border border-rule bg-surface";

/** Sentence-case section label inside a panel ("New", "Totals", "Paying now"). */
export const PANEL_LABEL = "text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-3";
