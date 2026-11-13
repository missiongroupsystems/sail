import { req } from "@/lib/api";
import { getScope, orSignIn, registerToday, requireApi } from "@/lib/api.server";
import { ZReportView } from "./ZReportView";

export const metadata = { title: "Z-report" };

export default async function ZReportPage() {
  const api = await requireApi();
  const scope = await getScope();
  const outlets = await orSignIn(req(api.GET("/v1/outlets")));
  const outletId = outlets.data.find((o) => o.id === scope.outletId)?.id ?? outlets.data[0]?.id ?? null;
  return <ZReportView outlets={outlets.data} scope={scope} initialOutletId={outletId} today={await registerToday(api, outletId)} />;
}
