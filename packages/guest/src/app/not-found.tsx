import { QrCode } from "lucide-react";
import { Notice } from "@/components/Notices";

export default function NotFound() {
  return <Notice icon={QrCode} title="This page doesn't exist" body="Scan the QR code on your table to see the menu." />;
}
