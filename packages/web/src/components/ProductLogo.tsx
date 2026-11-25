import { cx, SailLogo, type SailLogoProps } from "@sail/ui";
import { PRODUCT_MARK, PRODUCT_NAME } from "@/lib/brand";

/**
 * The product's logo: Sail's, or a downstream build's name and mark (extensions/types.ts). `slot` gives a downstream
 * logo a fixed width, so what follows stands still whatever the name's length; a longer name truncates. Sail's own logo
 * keeps its width.
 */
export function ProductLogo({ slot, className, ...props }: Omit<SailLogoProps, "name" | "mark" | "fit"> & { slot?: string }) {
  const downstream = PRODUCT_MARK !== undefined && slot !== undefined;
  return <SailLogo {...props} className={cx(className, downstream && slot)} name={PRODUCT_NAME} mark={PRODUCT_MARK} fit={downstream} />;
}
