import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi, scopedOutlets } from "@/lib/api.server";
import { ChannelsView } from "./ChannelsView";

export const metadata = { title: "Channels" };

export default async function ChannelsPage() {
  const api = await requireApi();
  // Channels are a brand's: the list is the brand in scope, at that brand's outlets.
  const scope = await getScope();
  const brand_id = scope.brandId ?? undefined;
  const [links, outlets, brands, menus] = await orSignIn(Promise.all([req(api.GET("/v1/channel-links", { params: { query: { include_archived: "true", brand_id } } })), scopedOutlets().then((data) => ({ data })), req(api.GET("/v1/brands")), req(api.GET("/v1/menus"))]));
  return <ChannelsView initialLinks={links.data} outlets={outlets.data} brands={brands.data} menus={menus.data} brandId={scope.brandId} />;
}
