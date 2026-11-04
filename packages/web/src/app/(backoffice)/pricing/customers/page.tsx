import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { CustomersView } from "./CustomersView";

export const metadata = { title: "Customers & groups" };

export default async function CustomersPage() {
  const api = await requireApi();
  const [groups, customers] = await orSignIn(Promise.all([req(api.GET("/v1/customer-groups", { params: { query: { include_archived: "true" } } })), req(api.GET("/v1/customers", { params: { query: { limit: 50 } } }))]));
  return <CustomersView initialGroups={groups.data} initialCustomers={customers.data} />;
}
