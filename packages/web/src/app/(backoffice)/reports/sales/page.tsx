import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { SalesView } from "./SalesView";

export const metadata = { title: "Sales" };

export default async function SalesPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  return <SalesView outlets={outlets.data} scope={scope} initialOutletId={outletId} />;
}
