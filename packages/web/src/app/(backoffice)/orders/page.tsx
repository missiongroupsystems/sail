import { PageHeader } from "@sail/ui";
import { getScope, orSignIn, requireApi, scopedOutlets } from "@/lib/api.server";
import { dateParam, param, reportOutlet, type PageSearchParams } from "@/lib/url-params";
import { OrdersView } from "./OrdersView";

export const metadata = { title: "Orders" };

export default async function OrdersPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(scopedOutlets().then((data) => ({ data })));
  const outletId = reportOutlet(outlets.data, scope.outletId, params);
  const order = param(params, "order");
  return (
    <>
      <PageHeader title="Orders" description="Today's orders and every order. Open one for its lines, bills, refunds, tickets, events and audit trail. Servers read; Managers refund and reopen." />
      <OrdersView outlets={outlets.data} scope={scope} initialOutletId={outletId} initial={{ orderId: order && /^[0-9a-f-]{36}$/i.test(order) ? order : null, range: param(params, "range") === "all" ? "all" : null, date: dateParam(params, "date") }} />
    </>
  );
}
