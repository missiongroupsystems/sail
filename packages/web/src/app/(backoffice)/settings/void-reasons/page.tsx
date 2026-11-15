import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { VoidReasonsView } from "./VoidReasonsView";

export const metadata = { title: "Void reasons" };

export default async function VoidReasonsPage() {
  const api = await requireApi();
  const reasons = await orSignIn(req(api.GET("/v1/void-reasons", { params: { query: { include_archived: "true" } } })));
  return <VoidReasonsView initialReasons={reasons.data} />;
}
