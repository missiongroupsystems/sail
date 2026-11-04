import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { BrandsView } from "./BrandsView";

export const metadata = { title: "Brands" };

export default async function BrandsPage() {
  const api = await requireApi();
  const brands = await orSignIn(req(api.GET("/v1/brands", { params: { query: { include_archived: "true" } } })));
  return <BrandsView initialBrands={brands.data} />;
}
