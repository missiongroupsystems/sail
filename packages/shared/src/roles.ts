import { z } from "zod";

/**
 * The five fixed roles (scope doc 4.1). Server < Cashier < Manager; Finance
 * and Admin sit above Manager. "X+" means role X or any higher rank.
 */
export const ROLES = ["server", "cashier", "manager", "finance", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

const RANK: Record<Role, number> = { server: 10, cashier: 20, manager: 30, finance: 40, admin: 50 };

export function roleRank(role: Role): number {
  return RANK[role];
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** The lower of two roles (used for an agent acting on behalf of a person). */
export function lowerRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Tile and manual-rule access levels (scope doc 4.3). */
export const ACCESS_LEVELS = ["everyone", "cashier", "manager", "admin"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const AccessLevelSchema = z.enum(ACCESS_LEVELS);

export function accessLevelAllows(level: AccessLevel, role: Role): boolean {
  switch (level) {
    case "everyone":
      return true;
    case "cashier":
      return roleAtLeast(role, "cashier");
    case "manager":
      return roleAtLeast(role, "manager");
    case "admin":
      return role === "admin";
  }
}

/**
 * The fixed permission matrix: the minimum role for each restricted action,
 * and whether a manager override may authorise it for a lower role.
 * This is the single definition read by the API, the POS and the MCP manifest.
 */
export const PERMISSIONS = {
  "orders.open": { minRole: "server", overrideAllowed: false },
  "orders.update_details": { minRole: "server", overrideAllowed: false },
  "orders.change_type": { minRole: "server", overrideAllowed: false },
  "orders.attach_customer": { minRole: "server", overrideAllowed: false },
  "orders.move_table": { minRole: "server", overrideAllowed: false },
  "orders.fire": { minRole: "server", overrideAllowed: false },
  "orders.mark_ready": { minRole: "server", overrideAllowed: false },
  "orders.mark_out_for_delivery": { minRole: "server", overrideAllowed: false },
  "orders.complete": { minRole: "server", overrideAllowed: false },
  "orders.cancel": { minRole: "server", overrideAllowed: false },
  "orders.reopen": { minRole: "manager", overrideAllowed: true },
  "lines.add": { minRole: "server", overrideAllowed: false },
  "lines.add_open_price": { minRole: "manager", overrideAllowed: true },
  "lines.update": { minRole: "server", overrideAllowed: false },
  "lines.void": { minRole: "server", overrideAllowed: false },
  "lines.void_fired": { minRole: "manager", overrideAllowed: true },
  "adjustments.apply_manual": { minRole: "server", overrideAllowed: true }, // the rule's own min_role applies on top
  "adjustments.remove": { minRole: "server", overrideAllowed: true },
  "checks.split": { minRole: "server", overrideAllowed: false },
  "checks.print_prebill": { minRole: "server", overrideAllowed: false },
  "payments.record": { minRole: "cashier", overrideAllowed: true },
  "payments.void": { minRole: "manager", overrideAllowed: true },
  "documents.issue_invoice": { minRole: "cashier", overrideAllowed: false },
  "receipts.print": { minRole: "server", overrideAllowed: false },
  "receipts.send": { minRole: "cashier", overrideAllowed: false },
  "refunds.create": { minRole: "manager", overrideAllowed: true },
  "shifts.open": { minRole: "cashier", overrideAllowed: false },
  "shifts.close": { minRole: "cashier", overrideAllowed: false },
  "business_days.close": { minRole: "manager", overrideAllowed: false },
  "print_jobs.reprint": { minRole: "server", overrideAllowed: false },
  "print_jobs.reroute": { minRole: "server", overrideAllowed: false },
  "print_jobs.test": { minRole: "admin", overrideAllowed: false },
  "stock.mark_sold_out": { minRole: "cashier", overrideAllowed: false },
  "stock.restore": { minRole: "cashier", overrideAllowed: false },
  "stock.set_daily_cap": { minRole: "manager", overrideAllowed: false },
  "customers.find": { minRole: "server", overrideAllowed: false },
  "customers.upsert": { minRole: "cashier", overrideAllowed: false },
  "customer_groups.set_members": { minRole: "manager", overrideAllowed: false },
  "rounds.accept": { minRole: "server", overrideAllowed: false },
  "rounds.reject": { minRole: "server", overrideAllowed: false },
  "service_requests.acknowledge": { minRole: "server", overrideAllowed: false },
  "orders.manage_past": { minRole: "finance", overrideAllowed: false },
  "pricing_rules.edit": { minRole: "admin", overrideAllowed: false },
  "config.edit": { minRole: "admin", overrideAllowed: false },
  "staff.edit": { minRole: "admin", overrideAllowed: false },
  "stations.pair": { minRole: "admin", overrideAllowed: false },
  "relays.pair": { minRole: "admin", overrideAllowed: false },
  "overrides.grant": { minRole: "manager", overrideAllowed: false },
  "reports.run": { minRole: "manager", overrideAllowed: false },
  "audit.list": { minRole: "manager", overrideAllowed: false },
} as const satisfies Record<string, { minRole: Role; overrideAllowed: boolean }>;

export type PermissionKey = keyof typeof PERMISSIONS;

export function minRoleFor(key: PermissionKey): Role {
  return PERMISSIONS[key].minRole;
}

export function roleCan(role: Role, key: PermissionKey): boolean {
  return roleAtLeast(role, PERMISSIONS[key].minRole);
}

export function overrideAllowedFor(key: PermissionKey): boolean {
  return PERMISSIONS[key].overrideAllowed;
}
