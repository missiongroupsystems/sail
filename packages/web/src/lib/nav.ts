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
};

/** Every section from design 3.2, in order. Unbuilt sections still render, never a gap. */
export const SECTIONS: Section[] = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/orders", label: "Orders", icon: Receipt, arrives: "v0.4" },
  { href: "/menu", label: "Menu", icon: BookOpen, arrives: "v0.3" },
  { href: "/pricing", label: "Pricing", icon: Tags, arrives: "v0.3" },
  { href: "/floor", label: "Floor & QR", icon: LayoutGrid, arrives: "v0.4" },
  { href: "/printing", label: "Printing", icon: Printer, arrives: "v0.5" },
  { href: "/team", label: "Team", icon: Users },
  { href: "/reports", label: "Reports", icon: ChartNoAxesColumn, arrives: "v0.9" },
  { href: "/changes", label: "Changes", icon: GitPullRequestArrow, arrives: "v0.3" },
  { href: "/assistants", label: "Assistants", icon: Bot, arrives: "with the agent work" },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const SETTINGS_TABS = [
  { href: "/settings/outlets", label: "Outlets" },
  { href: "/settings/brands", label: "Brands" },
  { href: "/settings/stations", label: "Stations" },
  { href: "/settings/merchant", label: "Merchant" },
] as const;
