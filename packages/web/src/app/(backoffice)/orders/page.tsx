import { PageHeader } from "@sail/ui";
import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { OrdersView } from "./OrdersView";

export const metadata = { title: "Orders" };

export default async function OrdersPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  return (
    <>
      <PageHeader title="Orders" description="Today's orders and every order, read-only. Open one to see its lines, adjustments, events and audit trail." />
      <OrdersView outlets={outlets.data} scope={scope} initialOutletId={outletId} />
    </>
  );
}
