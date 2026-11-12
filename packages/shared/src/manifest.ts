import type { PermissionKey, Role } from "./roles.js";
import { PERMISSIONS } from "./roles.js";

/**
 * The operation manifest (vision 4.3): one entry per operation, read by the API
 * middleware, the POS (to show or grey out buttons), the MCP tool list and the
 * generated docs. CI fails if a route has no manifest entry.
 */
export type RiskTier = "T0" | "T1" | "T2" | "T3";
export type PrincipalKind = "staff" | "station" | "guest" | "relay" | "agent";

export type Toolset = "pos.read" | "pos.order" | "pos.payment" | "pos.refund" | "kitchen" | "guest" | "config.author" | "reports" | "watch";

export type OperationSpec = {
  /** `group.verb` */
  op: string;
  summary: string;
  /** Written for models as well as people: when to use it and what it never does. */
  description: string;
  tier: RiskTier;
  /** Null = any authenticated principal of the allowed kinds. */
  minRole: Role | null;
  overrideAllowed: boolean;
  reasonRequired: boolean;
  dryRun: boolean;
  /** Which principal kinds may call it. */
  principals: PrincipalKind[];
  emits: string[];
  mcp: { expose: boolean; toolsets: Toolset[] };
  /** When the role check comes from a permission key in the fixed matrix. */
  permission?: PermissionKey;
};

function fromPermission(key: PermissionKey): Pick<OperationSpec, "minRole" | "overrideAllowed" | "permission"> {
  return { minRole: PERMISSIONS[key].minRole, overrideAllowed: PERMISSIONS[key].overrideAllowed, permission: key };
}

const STAFF: PrincipalKind[] = ["staff", "agent"];
const STAFF_AND_STATION: PrincipalKind[] = ["staff", "station"];

export const OPERATIONS: Record<string, OperationSpec> = {
  "health.get": {
    op: "health.get",
    summary: "Health check",
    description: "Liveness and database connectivity. No authentication. Never returns business data.",
    tier: "T0",
    minRole: null,
    overrideAllowed: false,
    reasonRequired: false,
    dryRun: false,
    principals: [],
    emits: [],
    mcp: { expose: false, toolsets: [] },
  },
  "auth.me": {
    op: "auth.me",
    summary: "Who am I",
    description: "Returns the caller's principal: type, role, merchant and outlet scope. Use it to decide which buttons to show; the server enforces permissions regardless.",
    tier: "T0",
    minRole: null,
    overrideAllowed: false,
    reasonRequired: false,
    dryRun: false,
    principals: ["staff", "station", "guest", "relay", "agent"],
    emits: [],
    mcp: { expose: true, toolsets: ["pos.read", "reports", "watch", "config.author"] },
  },
  "merchants.get": {
    op: "merchants.get",
    summary: "Get the merchant and its settings",
    description: "Currency, locale, time zone, tax mode and rounding, default tax class, cash rounding, cash denominations for the cash counter, registration labels and business-day cutoff for the caller's merchant.",
    tier: "T0",
    minRole: "server",
    overrideAllowed: false,
    reasonRequired: false,
    dryRun: false,
    principals: STAFF_AND_STATION.concat("agent"),
    emits: [],
    mcp: { expose: true, toolsets: ["pos.read", "config.author", "reports"] },
  },
  "merchants.update_settings": {
    op: "merchants.update_settings",
    summary: "Update merchant settings",
    description: "Changes the locale, time zone, tax mode or rounding, default tax class, cash rounding increment, cash denominations, registration labels or the business-day cutoff. Affects every outlet. Orders already priced keep their tax snapshot. The currency cannot change once set.",
    tier: "T3",
    ...fromPermission("config.edit"),
    reasonRequired: false,
    dryRun: false,
    principals: STAFF,
    emits: ["merchant.settings_updated"],
    mcp: { expose: false, toolsets: [] },
  },
  "brands.list": { op: "brands.list", summary: "List brands", description: "Brands of the caller's merchant.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: STAFF_AND_STATION.concat("agent"), emits: [], mcp: { expose: true, toolsets: ["pos.read", "config.author"] } },
  "brands.create": { op: "brands.create", summary: "Create a brand", description: "Creates a brand under the merchant.", tier: "T3", ...fromPermission("config.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["brand.created"], mcp: { expose: false, toolsets: [] } },
  "brands.update": { op: "brands.update", summary: "Update a brand", description: "Renames a brand or changes its accent colour; archive by setting archived.", tier: "T3", ...fromPermission("config.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["brand.updated"], mcp: { expose: false, toolsets: [] } },
  "outlets.list": { op: "outlets.list", summary: "List outlets", description: "Outlets the caller can see (their outlet scope).", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: STAFF_AND_STATION.concat("agent"), emits: [], mcp: { expose: true, toolsets: ["pos.read", "config.author", "reports"] } },
  "outlets.create": { op: "outlets.create", summary: "Create an outlet", description: "Creates an outlet with its hours, business and tax registration numbers, and optional time zone, tax mode and business-day cutoff overrides.", tier: "T3", ...fromPermission("config.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["outlet.created"], mcp: { expose: false, toolsets: [] } },
  "outlets.update": { op: "outlets.update", summary: "Update an outlet", description: "Changes an outlet's details, hours, registration numbers or its time zone, tax mode and cutoff overrides.", tier: "T3", ...fromPermission("config.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["outlet.updated"], mcp: { expose: false, toolsets: [] } },
  "stations.list": { op: "stations.list", summary: "List stations", description: "POS stations of an outlet with their settings and pairing state.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: STAFF_AND_STATION, emits: [], mcp: { expose: false, toolsets: [] } },
  "stations.create": { op: "stations.create", summary: "Create a station", description: "Creates a station record for an outlet. Pair an iPad to it with stations.pair.", tier: "T3", ...fromPermission("config.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["station.created"], mcp: { expose: false, toolsets: [] } },
  "stations.update": { op: "stations.update", summary: "Update a station", description: "Changes a station's layout, printers, pay-before-firing or seat settings.", tier: "T3", ...fromPermission("config.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["station.updated"], mcp: { expose: false, toolsets: [] } },
  "staff.list": { op: "staff.list", summary: "List staff", description: "Staff of the merchant with role and outlet scope. PINs are never returned.", tier: "T0", minRole: "manager", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: STAFF, emits: [], mcp: { expose: true, toolsets: ["reports"] } },
  "staff.create": { op: "staff.create", summary: "Add a staff member", description: "Adds a staff member with a role, outlet and brand scope, optional back-office email and POS PIN.", tier: "T3", ...fromPermission("staff.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["staff.created"], mcp: { expose: false, toolsets: [] } },
  "staff.update": { op: "staff.update", summary: "Update a staff member", description: "Changes role, scope, PIN or active state.", tier: "T3", ...fromPermission("staff.edit"), reasonRequired: false, dryRun: false, principals: STAFF, emits: ["staff.updated"], mcp: { expose: false, toolsets: [] } },
  "audit.list": { op: "audit.list", summary: "List audit entries", description: "Who did what, on which target, when, and who approved it. Filter by actor, action, target or time.", tier: "T0", ...fromPermission("audit.list"), reasonRequired: false, dryRun: false, principals: STAFF, emits: [], mcp: { expose: true, toolsets: ["reports", "watch"] } },
  "events.list": { op: "events.list", summary: "Catch up on outlet events", description: "Events for an outlet after a sequence number. This is the source of truth for every live view; the SSE stream only signals that new events exist.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent", "relay"], emits: [], mcp: { expose: true, toolsets: ["watch", "pos.read"] } },
  "outlets.stream": { op: "outlets.stream", summary: "Outlet live-update stream (SSE)", description: "Server-sent events signalling new outlet events and print jobs. Clients catch up with events.list on connect, on a sequence gap, on visibility change and on `resync`.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "station", "agent"], emits: [], mcp: { expose: false, toolsets: [] } },
  "auth.dev_token": { op: "auth.dev_token", summary: "Mint a development sign-in token", description: "Development and tests only. Disabled in production.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: [], emits: [], mcp: { expose: false, toolsets: [] } },
};

export function operation(op: string): OperationSpec {
  const spec = OPERATIONS[op];
  if (!spec) throw new Error(`Unknown operation ${op}; add it to the manifest in shared/src/manifest.ts`);
  return spec;
}

/** Register operations from later phases (each phase's routes module calls this at import time). */
export function registerOperations(specs: Record<string, OperationSpec>) {
  for (const [k, v] of Object.entries(specs)) {
    if (k !== v.op) throw new Error(`manifest key ${k} does not match op ${v.op}`);
    OPERATIONS[k] = v;
  }
}

export const TIER_ORDER: Record<RiskTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
