import { Info } from "lucide-react";

/** The table has no open order (design 4.11): guests can browse, not order, until staff seat them. */
export function StaffBanner({ className }: { className?: string }) {
  return (
    <div role="status" aria-live="polite" className={`flex items-start gap-3 rounded-tile bg-surface-2 px-4 py-3 text-body text-ink ${className ?? ""}`}>
      <Info size={20} className="mt-0.5 shrink-0 text-status-seated" aria-hidden />
      <span>Your table isn&rsquo;t ready for ordering yet. Ask a member of staff to seat you.</span>
    </div>
  );
}
