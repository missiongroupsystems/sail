import type { Role } from "@sail/shared";

/**
 * The resolved caller of a request (scope doc 7.1 rule 8; vision 7.2). Every
 * principal maps onto the same RLS pipeline: set_config('app.current_*') then
 * SET LOCAL ROLE.
 */
export type PrincipalType = "staff" | "station" | "guest" | "relay" | "agent";

export type Principal =
  | {
      type: "staff";
      id: string;
      merchantId: string;
      role: Role;
      name: string;
      /** Empty = every outlet of the merchant. */
      outletIds: string[];
      brandIds: string[];
      /** Set when the staff member is signed in on a station with a PIN session. */
      stationId?: string;
      sessionId?: string;
      /** The outlet the station is bound to, when on a station. */
      outletId?: string;
      riskCeiling: string | null;
      via: "backoffice" | "pin";
    }
  | {
      /** An iPad paired to a station, before anyone has signed in with a PIN. */
      type: "station";
      id: string;
      merchantId: string;
      outletId: string;
      stationId: string;
    }
  | {
      type: "guest";
      id: string;
      merchantId: string;
      outletId: string;
      brandId: string;
      tableId: string;
      orderId: string | null;
      channelLinkId: string;
      sessionId: string;
    }
  | {
      type: "relay";
      id: string;
      merchantId: string;
      outletId: string;
      relayId: string;
    }
  | {
      type: "agent";
      id: string;
      merchantId: string;
      role: Role;
      name: string;
      outletIds: string[];
      brandIds: string[];
      identityId: string;
      sessionId: string;
      onBehalfOf: string | null;
      riskCeiling: string;
    };

/** The Postgres role for SET LOCAL ROLE. */
export function dbRoleFor(p: Principal): "app_authenticated" | "app_guest" | "app_relay" | "app_agent" {
  switch (p.type) {
    case "staff":
    case "station":
      return "app_authenticated";
    case "guest":
      return "app_guest";
    case "relay":
      return "app_relay";
    case "agent":
      return "app_agent";
  }
}

/** The outlet scope string stored in app.current_outlets: '*' or a comma list. */
export function outletScopeFor(p: Principal): string {
  switch (p.type) {
    case "staff":
      if (p.outletId) return p.outletId;
      return p.outletIds.length === 0 ? "*" : p.outletIds.join(",");
    case "agent":
      return p.outletIds.length === 0 ? "*" : p.outletIds.join(",");
    case "station":
    case "guest":
    case "relay":
      return p.outletId;
  }
}

export function principalRole(p: Principal): Role | null {
  return p.type === "staff" || p.type === "agent" ? p.role : null;
}

export function principalCanSeeOutlet(p: Principal, outletId: string): boolean {
  const scope = outletScopeFor(p);
  return scope === "*" || scope.split(",").includes(outletId);
}

export function actorOf(p: Principal) {
  return {
    principal_type: p.type,
    principal_id: p.id,
    role: principalRole(p),
    ...(p.type === "staff" ? { name: p.name, station_id: p.stationId } : {}),
    ...(p.type === "agent" ? { name: p.name, on_behalf_of: p.onBehalfOf ?? undefined, agent: { identity_id: p.identityId, session_id: p.sessionId } } : {}),
  };
}
