import type { ApiError } from "./api";
import type { BasketItem } from "./basket";
import { activeGroups, selectionFromModifiers, unmetRequirement } from "./modifiers";
import type { CompiledMenu } from "./types";

/** What went wrong when a round was sent, so the review page can put the register's words where they belong (design 7.8). */
export type SendError =
  | { kind: "table_not_open"; error: ApiError }
  | { kind: "rate_limited"; error: ApiError; retryIn: number }
  | { kind: "group"; error: ApiError; groupId: string }
  | { kind: "product"; error: ApiError; productId: string }
  | { kind: "general"; error: ApiError };

/**
 * The register names the modifier group, not the line, in a validation error
 * ("Choose 1 more: Protein" with details.group_id). Find the basket item it is
 * about: first one whose own unmet minimum is that group, else the first whose
 * product carries the group at all.
 */
export function findOffendingItem(items: BasketItem[], menu: CompiledMenu, groupId: string): BasketItem | null {
  for (const item of items) {
    const product = menu.products[item.product_id];
    if (!product) continue;
    const unmet = unmetRequirement(menu, product, selectionFromModifiers(item.modifiers));
    if (unmet?.group.id === groupId) return item;
  }
  for (const item of items) {
    const product = menu.products[item.product_id];
    if (!product) continue;
    if (activeGroups(menu, product, selectionFromModifiers(item.modifiers)).some((g) => g.id === groupId)) return item;
  }
  return null;
}

/** The basket item a `SendError` points at, or null when it is about the whole send. */
export function offendingKey(error: SendError | null, items: BasketItem[], menu: CompiledMenu): string | null {
  if (!error) return null;
  if (error.kind === "group") return findOffendingItem(items, menu, error.groupId)?.key ?? null;
  if (error.kind === "product") return items.find((i) => i.product_id === error.productId)?.key ?? null;
  return null;
}
