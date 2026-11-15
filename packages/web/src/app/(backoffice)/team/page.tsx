import { PageHeader } from "@sail/ui";
import { req } from "@/lib/api";
import { getScope, orSignIn, requireApi } from "@/lib/api.server";
import { TeamView } from "./TeamView";

export const metadata = { title: "Team" };

export default async function TeamPage() {
  const api = await requireApi();
  const scope = await getScope();
  const [staff, outlets, brands] = await orSignIn(
    Promise.all([req(api.GET("/v1/staff", { params: { query: { include_inactive: "true" } } })), req(api.GET("/v1/outlets")), req(api.GET("/v1/brands"))]),
  );
  return (
    <>
      <PageHeader title="Team" description="Staff, their roles and where they can work. PINs are set here and never shown." />
      <TeamView initialStaff={staff.data} outlets={outlets.data} brands={brands.data} scope={scope} />
    </>
  );
}
