import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { TendersView } from "./TendersView";

export const metadata = { title: "Tenders" };

export default async function TendersPage() {
  const api = await requireApi();
  const tenders = await orSignIn(req(api.GET("/v1/tender-types", { params: { query: { include_archived: "true" } } })));
  return <TendersView initialTenders={tenders.data} />;
}
