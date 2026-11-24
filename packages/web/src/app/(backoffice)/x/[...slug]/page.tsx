import pages from "@sail/extensions/pages";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/api.server";
import { extensionPage } from "@/lib/nav";

/**
 * A page a downstream build adds (extensions/types.ts); stock Sail has none, so every /x/ path is not found. A page
 * with a minimum role shows the refusal page to anyone below it, before the page itself renders.
 */
export default async function ExtensionPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const path = (await params).slug.join("/");
  const page = extensionPage(path);
  const Page = page && Object.hasOwn(pages, path) ? pages[path] : undefined;
  if (!page || !Page) notFound();
  if (page.minRole) await requireRole(page.minRole);
  return <Page />;
}
