import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { CategoriesView } from "./CategoriesView";

export const metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const api = await requireApi();
  const categories = await orSignIn(req(api.GET("/v1/categories", { params: { query: { include_archived: "true" } } })));
  return <CategoriesView initialCategories={categories.data} />;
}
