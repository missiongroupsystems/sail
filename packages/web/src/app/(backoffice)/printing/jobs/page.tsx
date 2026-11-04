import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { PrintJobsView } from "./PrintJobsView";

export const metadata = { title: "Print jobs" };

export default async function PrintJobsPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  const printers = outletId ? await orSignIn(req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId, include_archived: "true" } } }))) : null;
  return <PrintJobsView outlets={outlets.data} scope={scope} initialOutletId={outletId} initialPrinters={printers?.data ?? []} />;
}
