import { SailLogo, type SailLogoProps } from "@sail/ui";
import { PRODUCT_MARK, PRODUCT_NAME } from "@/lib/brand";

/** The product's logo: Sail's, or a downstream build's name and mark (extensions/types.ts). */
export function ProductLogo(props: Omit<SailLogoProps, "name" | "mark">) {
  return <SailLogo {...props} name={PRODUCT_NAME} mark={PRODUCT_MARK} />;
}
