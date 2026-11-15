import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { MerchantForm } from "./MerchantForm";

export const metadata = { title: "Merchant" };

export default async function MerchantPage() {
  const api = await requireApi();
  const merchant = await orSignIn(req(api.GET("/v1/merchant")));
  return <MerchantForm initialMerchant={merchant.data} />;
}
