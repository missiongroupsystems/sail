import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { OutletsView } from "./OutletsView";

export const metadata = { title: "Outlets" };

export default async function OutletsPage() {
  const api = await requireApi();
  const outlets = await orSignIn(req(api.GET("/v1/outlets", { params: { query: { include_archived: "true" } } })));
  return <OutletsView initialOutlets={outlets.data} />;
}
