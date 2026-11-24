import {
  BookOpen,
  ChartNoAxesColumn,
  History,
  LayoutGrid,
  Printer,
  Receipt,
  Settings,
  Sun,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@sail/shared";
import extensions from "@sail/extensions";

export type Section = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The lowest role the register lets read this section; the rail leaves it out for anyone below. */
  minRole?: Role;
};

/** Every section, in order. Only destinations that exist: a section arrives in the rail with its page (A P12). */
export const SECTIONS: Section[] = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/orders", label: "Orders", icon: Receipt },
  { href: "/menu", label: "Menu", icon: BookOpen },
  { href: "/pricing", label: "Pricing", icon: Tags },
  { href: "/floor", label: "Floor & QR", icon: LayoutGrid },
  { href: "/printing", label: "Printing", icon: Printer },
  { href: "/team", label: "Team", icon: Users, minRole: "manager" },
  { href: "/reports", label: "Reports", icon: ChartNoAxesColumn, minRole: "manager" },
  // The audit log: every change, by whom, approved by whom (audit.list is a Manager's).
  { href: "/audit", label: "Changes", icon: History, minRole: "manager" },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** The rail: Sail's sections, then any a downstream build adds (extensions/types.ts). */
export const RAIL: Section[] = [...SECTIONS, ...(extensions.nav ?? [])];

/** The product's name: Sail's, unless a downstream build names its own. */
export const PRODUCT_NAME = extensions.brand?.name ?? "Sail";

export const SETTINGS_TABS = [
  { href: "/settings/outlets", label: "Outlets" },
  { href: "/settings/brands", label: "Brands" },
  { href: "/settings/stations", label: "Stations" },
  { href: "/settings/channels", label: "Channels" },
  { href: "/settings/payment-methods", label: "Payment methods" },
  { href: "/settings/tax", label: "Tax classes" },
  { href: "/settings/void-reasons", label: "Void reasons" },
  { href: "/settings/merchant", label: "Merchant" },
] as const;

/** Menu section tabs: products, modifiers, menus and sections, availability, sold out. */
export const MENU_TABS = [
  { href: "/menu/products", label: "Products" },
  { href: "/menu/modifiers", label: "Modifier groups" },
  { href: "/menu/menus", label: "Menus & sections" },
  { href: "/menu/categories", label: "Categories" },
  { href: "/menu/availability", label: "Availability" },
  { href: "/menu/sold-out", label: "Sold out" },
  // Imports are an Admin's (imports.list): the tab is left out for anyone below, as the rail leaves out a section.
  { href: "/menu/import", label: "Import", minRole: "admin" },
] as const;

/** Pricing section tabs: rules, simulator, customer groups; tax classes and rounding live in settings. */
export const PRICING_TABS = [
  { href: "/pricing/rules", label: "Rules" },
  { href: "/pricing/simulator", label: "Simulator" },
  { href: "/pricing/customers", label: "Customers & groups" },
] as const;

/** Printing section tabs: printers, relays, the print job queue. */
export const PRINTING_TABS = [
  { href: "/printing/printers", label: "Printers" },
  { href: "/printing/relays", label: "Relays" },
  { href: "/printing/jobs", label: "Print jobs" },
] as const;

/** Reports section tabs: the Z-report and shifts arrive now; the rest in a later phase. */
export const REPORTS_TABS = [
  { href: "/reports", label: "Overview", match: "exact" },
  { href: "/reports/z-report", label: "Z-report" },
  { href: "/reports/sales", label: "Sales" },
  { href: "/reports/items", label: "Items" },
  { href: "/reports/shifts", label: "Shifts" },
  { href: "/reports/print-health", label: "Print health" },
] as const;

/**
 * The lowest role each restricted page needs, by path prefix (most specific first), for the refusal page to name it.
 * Each matches the register's own rule for what the page reads.
 */
export const PAGE_MIN_ROLE: { prefix: string; role: Role }[] = [
  { prefix: "/menu/import", role: "admin" },
  { prefix: "/pricing/simulator", role: "manager" },
  { prefix: "/reports", role: "manager" },
  { prefix: "/team", role: "manager" },
  { prefix: "/audit", role: "manager" },
];

/** The lowest role a page needs, or null when the page names none. */
export function pageMinRole(path: string | null): Role | null {
  if (!path) return null;
  return PAGE_MIN_ROLE.find((p) => path === p.prefix || path.startsWith(`${p.prefix}/`))?.role ?? null;
}
