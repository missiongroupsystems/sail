import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { StationsView } from "./StationsView";

export const metadata = { title: "Stations" };

export default async function StationsPage() {
  const api = await requireApi();
  const scope = await getScope();
  const [outlets, brands] = await orSignIn(Promise.all([req(api.GET("/v1/outlets")), req(api.GET("/v1/brands"))]));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const stations = outletId ? await orSignIn(req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId }, query: { include_archived: "true" } } }))) : null;
  return <StationsView outlets={outlets.data} brands={brands.data} scope={scope} initialOutletId={outletId} initialStations={stations?.data ?? []} />;
}
