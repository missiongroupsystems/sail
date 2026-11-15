import type { FieldValues, Path, UseFormSetError } from "react-hook-form";

/**
 * The register refuses a change it cannot use with a 400 and a plain message. When the refusal names a field (a
 * validation issue with a `path`, or `details.field`), the message belongs under that field; the whole message is
 * still shown at the foot of the form, so nothing is refused silently.
 */
export type ServerFieldError = { field: string; message: string };

type Issue = { path?: unknown; message?: unknown };

/** Field names the refusal points at, as dotted paths ("components.0.bps"), with a message for each. */
export function serverFieldErrors(error: { message: string; details?: Record<string, unknown> } | null | undefined): ServerFieldError[] {
  if (!error?.details) return [];
  const out: ServerFieldError[] = [];
  const issues = Array.isArray(error.details.issues) ? (error.details.issues as Issue[]) : [];
  issues.forEach((issue, i) => {
    // A path is an array of keys, or (from some registers) already dotted: "components.0.bps".
    const field = Array.isArray(issue.path) ? issue.path.map(String).join(".") : typeof issue.path === "string" ? issue.path : "";
    if (!field) return;
    // The register's own message describes the first issue in plain words, unless it only prefixes the field's name.
    const own = typeof issue.message === "string" ? issue.message : null;
    const message = i === 0 && !(own && error.message.startsWith(`${field}:`)) ? error.message : (own ?? error.message);
    if (!out.some((e) => e.field === field)) out.push({ field, message });
  });
  if (typeof error.details.field === "string" && !out.some((e) => e.field === error.details!.field)) out.push({ field: error.details.field, message: error.message });
  return out;
}

/**
 * Puts each refusal that names one of `fields` under that field of a react-hook-form form. `rename` maps the API's
 * field name to the form's where they differ. Returns how many fields were marked.
 */
export function applyServerErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  error: { message: string; details?: Record<string, unknown> } | null | undefined,
  fields: readonly string[],
  rename: Record<string, string> = {},
): number {
  let marked = 0;
  for (const e of serverFieldErrors(error)) {
    const name = rename[e.field] ?? e.field;
    if (!fields.includes(name)) continue;
    setError(name as Path<T>, { type: "server", message: e.message });
    marked++;
  }
  return marked;
}
