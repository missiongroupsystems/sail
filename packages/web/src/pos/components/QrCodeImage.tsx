"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** A QR code for a register URL (receipt links), drawn on the iPad from the `qrcode` library; the URL itself comes from the register. */
export function QrCodeImage({ url, size = 240, label, className }: { url: string; size?: number; label: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: size * 2, color: { dark: "#1c1d1f", light: "#ffffff" } })
      .then((data) => {
        if (!cancelled) setSrc(data);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url, size]);
  if (!src) return <div aria-busy className={`animate-skeleton rounded-tile bg-surface-2 ${className ?? ""}`} style={{ width: size, height: size }} />;
  return <img src={src} width={size} height={size} alt={label} className={`pos-qr rounded-tile bg-white p-2 ${className ?? ""}`} />;
}
