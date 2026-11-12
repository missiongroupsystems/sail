import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { ItemsView } from "./ItemsView";

export const metadata = { title: "Items" };

export default async function ItemsPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  return <ItemsView outlets={outlets.data} scope={scope} initialOutletId={outletId} />;
}
