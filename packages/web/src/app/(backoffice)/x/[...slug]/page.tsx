import extensions from "@sail/extensions";
import { notFound } from "next/navigation";

/** A page a downstream build adds (extensions/types.ts); stock Sail has none, so every /x/ path is not found. */
export default async function ExtensionPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const path = (await params).slug.join("/");
  const Page = extensions.pages && Object.hasOwn(extensions.pages, path) ? extensions.pages[path] : undefined;
  if (!Page) notFound();
  return <Page />;
}
