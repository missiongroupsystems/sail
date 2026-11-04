import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { RelaysView } from "./RelaysView";

export const metadata = { title: "Relays" };

export default async function RelaysPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const [relays, printers] = outletId
    ? await orSignIn(Promise.all([req(api.GET("/v1/relays", { params: { query: { outlet_id: outletId, include_archived: "true" } } })), req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId } } }))]))
    : [null, null];
  return <RelaysView outlets={outlets.data} scope={scope} initialOutletId={outletId} initialRelays={relays?.data ?? []} initialPrinters={printers?.data ?? []} />;
}
