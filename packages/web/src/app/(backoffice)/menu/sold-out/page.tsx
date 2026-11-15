import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { SoldOutView } from "./SoldOutView";

export const metadata = { title: "Sold out" };

export default async function SoldOutPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const stock = outletId ? await orSignIn(req(api.GET("/v1/outlets/{id}/stock", { params: { path: { id: outletId } } }))) : null;
  return <SoldOutView outlets={outlets.data} scope={scope} initialOutletId={outletId} initialStock={stock?.data ?? []} />;
}
