import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { MerchantForm } from "./MerchantForm";
import { SharedByAllBrands } from "@/components/backoffice/SharedByAllBrands";

export const metadata = { title: "Merchant" };

export default async function MerchantPage() {
  const api = await requireApi();
  const merchant = await orSignIn(req(api.GET("/v1/merchant")));
  return (
    <>
      <SharedByAllBrands />
      <MerchantForm initialMerchant={merchant.data} />
    </>
  );
}
