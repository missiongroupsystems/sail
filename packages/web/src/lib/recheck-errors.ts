"use client";

import { useEffect } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";

/**
 * A form's own field errors follow the fields they depend on. React Hook Form re-checks only the field being edited, so
 * "Maximum cannot be below the minimum" stayed on Maximum after Minimum was lowered (live test R new 4). Once the form
 * has been submitted, any change re-checks every field that is showing an error, so one that is now right clears.
 */
export function useRecheckErrors<T extends FieldValues>(form: UseFormReturn<T>) {
  const values = form.watch();
  const key = JSON.stringify(values ?? null);
  const { isSubmitted } = form.formState;
  useEffect(() => {
    // The register's own refusals (`type: "server"`) are not the form's to re-check; they clear when the sheet resubmits.
    const errors = form.formState.errors as Record<string, { type?: unknown } | undefined>;
    const failing = Object.keys(errors).filter((k) => errors[k]?.type !== "server");
    if (isSubmitted && failing.length) void form.trigger(failing as Parameters<typeof form.trigger>[0]);
    // Only a change of value re-checks; the errors themselves are read when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
