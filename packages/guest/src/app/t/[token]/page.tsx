import { GuestApp } from "@/components/GuestApp";

/** The table's QR code lands here. One long-lived client page: menu, review, status and "Our table" live inside it. */
export default async function TablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <GuestApp token={token} />;
}
