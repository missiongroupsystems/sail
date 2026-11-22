import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { ModifierGroupsView } from "./ModifierGroupsView";
import { SharedByAllBrands } from "@/components/backoffice/SharedByAllBrands";

export const metadata = { title: "Modifier groups" };

export default async function ModifierGroupsPage() {
  const api = await requireApi();
  const groups = await orSignIn(req(api.GET("/v1/modifier-groups", { params: { query: { include_archived: "true", limit: 500 } } })));
  return (
    <>
      <SharedByAllBrands />
      <ModifierGroupsView initialGroups={groups.data} />
    </>
  );
}
