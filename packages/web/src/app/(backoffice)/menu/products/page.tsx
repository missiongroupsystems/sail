import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { ProductsView } from "./ProductsView";

export const metadata = { title: "Products" };

export default async function ProductsPage() {
  const api = await requireApi();
  const scope = await getScope();
  const [first, categories, brands] = await orSignIn(
    Promise.all([
      req(api.GET("/v1/products", { params: { query: { limit: 50, brand_id: scope.brandId ?? undefined } } })),
      req(api.GET("/v1/categories")),
      req(api.GET("/v1/brands")),
    ]),
  );
  return <ProductsView initialPage={first} categories={categories.data} brands={brands.data} scope={scope} />;
}
