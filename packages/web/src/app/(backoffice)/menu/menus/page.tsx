import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { MenusView } from "./MenusView";

export const metadata = { title: "Menus & sections" };

export default async function MenusPage() {
  const api = await requireApi();
  const scope = await getScope();
  const [menus, brands] = await orSignIn(Promise.all([req(api.GET("/v1/menus", { params: { query: { include_archived: "true" } } })), req(api.GET("/v1/brands"))]));
  return <MenusView initialMenus={menus.data} brands={brands.data} scope={scope} />;
}
