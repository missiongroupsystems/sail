import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { AvailabilityView } from "./AvailabilityView";

export const metadata = { title: "Availability" };

export default async function AvailabilityPage() {
  const api = await requireApi();
  const [rules, outlets, menus] = await orSignIn(Promise.all([req(api.GET("/v1/availability-rules")), req(api.GET("/v1/outlets")), req(api.GET("/v1/menus"))]));
  return <AvailabilityView initialRules={rules.data} outlets={outlets.data} menus={menus.data} />;
}
