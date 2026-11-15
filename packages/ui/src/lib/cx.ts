/** Joins class names, dropping falsy values. No merging: conflicting utilities are a design bug. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out;
}

/** Narrow a React Aria `className` prop (string or render-prop function) to a string, with ours appended. */
export function withClass<T>(
  own: string,
  theirs: string | ((values: T) => string) | undefined,
): string | ((values: T) => string) {
  if (typeof theirs === "function") return (values: T) => cx(own, theirs(values));
  return cx(own, theirs);
}
