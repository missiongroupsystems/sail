/**
 * An outlet's own name where its brand is already in view. Names are stored whole ("Quay Coffee · Dock"); the brand
 * comes off only as a clean "<brand> · " prefix with something after it, so any other name is shown as it is.
 */
export function outletOwnName(name: string, brandName: string | null | undefined): string {
  if (!brandName) return name;
  const prefix = `${brandName} · `;
  if (!name.startsWith(prefix)) return name;
  const rest = name.slice(prefix.length).trim();
  return rest ? rest : name;
}
