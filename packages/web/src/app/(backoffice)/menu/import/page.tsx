import { req } from "@/lib/api";
import { orSignIn, requireApi } from "@/lib/api.server";
import { ImportView } from "./ImportView";

export const metadata = { title: "Import" };

export default async function ImportPage() {
  const api = await requireApi();
  const jobs = await orSignIn(req(api.GET("/v1/imports")));
  return <ImportView initialJobs={jobs.data} />;
}
