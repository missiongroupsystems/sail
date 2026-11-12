import type { Metadata } from "next";
import { localeFromAcceptLanguage } from "@sail/ui";
import { headers } from "next/headers";
import { ReceiptPage } from "@/components/ReceiptPage";

export const metadata: Metadata = { title: "Receipt" };

/** A digital receipt link (receipts.send with channel "qr" or "link"). Public; it expires. */
export default async function ReceiptRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const fallbackLocale = localeFromAcceptLanguage((await headers()).get("accept-language")) ?? "en";
  return <ReceiptPage token={token} fallbackLocale={fallbackLocale} />;
}
