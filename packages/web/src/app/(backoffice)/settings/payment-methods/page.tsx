import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { PaymentMethodsView } from "./PaymentMethodsView";
import { SharedByAllBrands } from "@/components/backoffice/SharedByAllBrands";

export const metadata = { title: "Payment methods" };

export default async function PaymentMethodsPage() {
  const api = await requireApi();
  const tenders = await orSignIn(req(api.GET("/v1/tender-types", { params: { query: { include_archived: "true" } } })));
  return (
    <>
      <SharedByAllBrands />
      <PaymentMethodsView initialTenders={tenders.data} />
    </>
  );
}
