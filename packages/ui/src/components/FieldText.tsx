import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { fieldLabel, fieldWrap } from "./field";

/** A field's value shown as plain text where it cannot change: the field's label, then the value, with no control. */
export function FieldText({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <dl className={cx(fieldWrap, className)}>
      <dt className={fieldLabel}>{label}</dt>
      <dd className="text-body text-ink">{children}</dd>
    </dl>
  );
}
