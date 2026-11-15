import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { PrintersView } from "./PrintersView";

export const metadata = { title: "Printers" };

export default async function PrintersPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const [printers, relays, stations] = outletId
    ? await orSignIn(
        Promise.all([
          req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId, include_archived: "true" } } })),
          req(api.GET("/v1/relays", { params: { query: { outlet_id: outletId } } })),
          req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId } } })),
        ]),
      )
    : [null, null, null];
  return <PrintersView outlets={outlets.data} scope={scope} initialOutletId={outletId} initialPrinters={printers?.data ?? []} initialRelays={relays?.data ?? []} initialStations={stations?.data ?? []} />;
}
