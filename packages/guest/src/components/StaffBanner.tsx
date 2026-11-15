import { BrandButton, Icon } from "@sail/ui";
import { Info } from "lucide-react";

/**
 * The table has no open order: guests can browse, not order, until staff seat them. The page checks again on its
 * own; "Check again" asks now, for a guest who has just been seated.
 */
export function StaffBanner({ className, onCheck }: { className?: string; onCheck?: () => void }) {
  return (
    <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sheet bg-status-seated-tint px-4 py-3 text-[15px] leading-snug text-ink ${className ?? ""}`}>
      <Icon icon={Info} size={20} className="shrink-0 text-status-seated" />
      {/* Two lines on a 360px phone: the button moves under the sentence rather than squeezing it to four. */}
      <span className="min-w-[11rem] flex-1">Your table isn&rsquo;t ready for ordering yet. Ask a member of staff to seat you.</span>
      {onCheck ? (
        <BrandButton variant="secondary" onPress={onCheck} className="min-h-11 shrink-0 px-4 text-[14.5px] max-[379px]:ml-8">
          Check again
        </BrandButton>
      ) : null}
    </div>
  );
}
