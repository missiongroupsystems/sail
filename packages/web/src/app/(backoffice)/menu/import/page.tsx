import { req } from "@/lib/api";
import { orSignIn, requireApi, requireRole } from "@/lib/api.server";
import { ImportView } from "./ImportView";

export const metadata = { title: "Import" };

export default async function ImportPage() {
  // Imports are an Admin's: anyone below gets the refusal page naming that role, before any part of the page loads.
  await requireRole("admin");
  const api = await requireApi();
  const jobs = await orSignIn(req(api.GET("/v1/imports")));
  return <ImportView initialJobs={jobs.data} />;
}
