import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { ChannelsView } from "./ChannelsView";

export const metadata = { title: "Channels" };

export default async function ChannelsPage() {
  const api = await requireApi();
  const [links, outlets, brands, menus] = await orSignIn(Promise.all([req(api.GET("/v1/channel-links", { params: { query: { include_archived: "true" } } })), req(api.GET("/v1/outlets")), req(api.GET("/v1/brands")), req(api.GET("/v1/menus"))]));
  return <ChannelsView initialLinks={links.data} outlets={outlets.data} brands={brands.data} menus={menus.data} />;
}
