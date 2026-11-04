import { Notice } from "@/components/Notices";

/** There is nothing to do here without a table code: the QR code on the table opens /t/<token>. */
export default function HomePage() {
  return <Notice title="Scan to order" body="Scan the QR code on your table to see the menu and order from your phone." />;
}
