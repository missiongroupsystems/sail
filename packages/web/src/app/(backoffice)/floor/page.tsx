import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { FloorIntro, FloorView } from "./FloorView";

export const metadata = { title: "Floor & QR" };

export default async function FloorPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const [areas, tables] = outletId
    ? await orSignIn(Promise.all([req(api.GET("/v1/areas", { params: { query: { outlet_id: outletId } } })), req(api.GET("/v1/tables", { params: { query: { outlet_id: outletId, include_archived: "true" } } }))]))
    : [null, null];
  return (
    <>
      <FloorIntro />
      <FloorView outlets={outlets.data} scope={scope} initialOutletId={outletId} initialAreas={areas?.data ?? []} initialTables={tables?.data ?? []} />
    </>
  );
}
