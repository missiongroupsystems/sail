import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { TaxClassesView } from "./TaxClassesView";

export const metadata = { title: "Tax classes" };

export default async function TaxClassesPage() {
  const api = await requireApi();
  const [classes, outlets] = await orSignIn(Promise.all([req(api.GET("/v1/tax-classes", { params: { query: { include_archived: "true" } } })), req(api.GET("/v1/outlets"))]));
  return <TaxClassesView initialClasses={classes.data} outlets={outlets.data} />;
}
