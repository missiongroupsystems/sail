import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { RulesView } from "./RulesView";

export const metadata = { title: "Pricing rules" };

export default async function RulesPage() {
  const api = await requireApi();
  const [rules, outlets, brands, categories, groups] = await orSignIn(
    Promise.all([req(api.GET("/v1/pricing-rules")), req(api.GET("/v1/outlets")), req(api.GET("/v1/brands")), req(api.GET("/v1/categories")), req(api.GET("/v1/customer-groups"))]),
  );
  return <RulesView initialVersions={rules.data} outlets={outlets.data} brands={brands.data} categories={categories.data} groups={groups.data} />;
}
