import { scopeLists } from "@/lib/api.server";

/**
 * At the top of a page whose records belong to the merchant, not to a brand (tax, payment methods, categories,
 * pricing rules): the list is the same whichever brand is in the scope picker, and the note says so, so that nobody
 * takes it for a filter that failed. A merchant with one brand has no other brand to wonder about, and gets no note.
 */
export async function SharedByAllBrands() {
  const { brands } = await scopeLists().catch(() => ({ brands: [] as { archived?: boolean }[] }));
  if (brands.filter((b) => !b.archived).length < 2) return null;
  return (
    <p role="note" className="mb-4 inline-flex min-h-8 items-center rounded-chip bg-surface-2 px-3 text-[13px] text-ink-2">
      Shared by all brands
    </p>
  );
}
