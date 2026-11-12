import {
  BookOpen,
  Bot,
  ChartNoAxesColumn,
  GitPullRequestArrow,
  LayoutGrid,
  Printer,
  Receipt,
  Settings,
  Sun,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

export type Section = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Roadmap phase when the section is not built yet (design 11.4). */
  arrives?: string;
  /** One line on what the section will hold, shown on its placeholder page. */
  summary?: string;
};

/** Every section from design 3.2, in order. Unbuilt sections still render, never a gap. */
export const SECTIONS: Section[] = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/orders", label: "Orders", icon: Receipt },
  { href: "/menu", label: "Menu", icon: BookOpen },
  { href: "/pricing", label: "Pricing", icon: Tags },
  { href: "/floor", label: "Floor & QR", icon: LayoutGrid },
  { href: "/printing", label: "Printing", icon: Printer },
  { href: "/team", label: "Team", icon: Users },
  { href: "/reports", label: "Reports", icon: ChartNoAxesColumn },
  { href: "/changes", label: "Changes", icon: GitPullRequestArrow, arrives: "with the agent work", summary: "Every configuration change, from a person or an assistant, will be reviewed here before it applies: summary, checks and impact first, then the row-level diff (design 4.10)." },
  { href: "/assistants", label: "Assistants", icon: Bot, arrives: "with the agent work", summary: "Assistant identities and roles, playbooks, activity and traces, budgets, and the on/off switch. Until then the register runs with assistants off." },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const SETTINGS_TABS = [
  { href: "/settings/outlets", label: "Outlets" },
  { href: "/settings/brands", label: "Brands" },
  { href: "/settings/stations", label: "Stations" },
  { href: "/settings/channels", label: "Channels" },
  { href: "/settings/tenders", label: "Tenders" },
  { href: "/settings/tax", label: "Tax classes" },
  { href: "/settings/void-reasons", label: "Void reasons" },
  { href: "/settings/merchant", label: "Merchant" },
] as const;

/** Menu section tabs (design 3.2): products, modifiers, menus and sections, availability, sold out. */
export const MENU_TABS = [
  { href: "/menu/products", label: "Products" },
  { href: "/menu/modifiers", label: "Modifier groups" },
  { href: "/menu/menus", label: "Menus & sections" },
  { href: "/menu/categories", label: "Categories" },
  { href: "/menu/availability", label: "Availability" },
  { href: "/menu/sold-out", label: "Sold out" },
  { href: "/menu/import", label: "Import" },
] as const;

/** Pricing section tabs: rules, simulator, customer groups; tax classes and rounding live in settings. */
export const PRICING_TABS = [
  { href: "/pricing/rules", label: "Rules" },
  { href: "/pricing/simulator", label: "Simulator" },
  { href: "/pricing/customers", label: "Customers & groups" },
] as const;

/** Printing section tabs (design 3.2): printers, relays, the print job queue. */
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
