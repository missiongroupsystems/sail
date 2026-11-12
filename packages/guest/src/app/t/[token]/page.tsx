import { localeFromAcceptLanguage } from "@sail/ui";
import { headers } from "next/headers";
import { GuestApp } from "@/components/GuestApp";

/** The table's QR code lands here. One long-lived client page: menu, review, status and "Our table" live inside it. */
export default async function TablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const fallbackLocale = localeFromAcceptLanguage((await headers()).get("accept-language")) ?? "en";
  return <GuestApp token={token} fallbackLocale={fallbackLocale} />;
}
