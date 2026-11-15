import { ApiError, req } from "@/lib/api";
import { getScope, orSignIn, requireApi, requireRole } from "@/lib/api.server";
import type { PricingRuleVersion } from "@/lib/api/types";
import { SimulatorView } from "./SimulatorView";

export const metadata = { title: "Pricing simulator" };

export default async function SimulatorPage() {
  // Running the simulator is a Manager's (pricing.simulate).
  await requireRole("manager");
  const api = await requireApi();
  const scope = await getScope();
  const [outlets, brands, groups, merchant] = await orSignIn(Promise.all([req(api.GET("/v1/outlets")), req(api.GET("/v1/brands")), req(api.GET("/v1/customer-groups")), req(api.GET("/v1/merchant"))]));

  // The active rule set feeds the manual-rule picker. If the register cannot resolve it, the page still renders and says so.
  let activeRules: PricingRuleVersion[] = [];
  let rulesError: { message: string; remedy?: string } | null = null;
  try {
    activeRules = (await orSignIn(req(api.GET("/v1/pricing-rules", { params: { query: { active_at: new Date().toISOString() } } })))).data;
  } catch (e) {
    if (e instanceof ApiError && !e.isUnauthenticated) rulesError = { message: e.message, remedy: e.remedy ?? "Manual rules cannot be picked until the register resolves the active rule set." };
    else throw e;
  }

  return <SimulatorView outlets={outlets.data} brands={brands.data} groups={groups.data} activeRules={activeRules} rulesError={rulesError} scope={scope} merchantTaxMode={merchant.data.settings.tax_mode} />;
}
