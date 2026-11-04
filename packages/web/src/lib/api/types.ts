import type { ClientPathsWithMethod, MethodResponse } from "openapi-fetch";
import type { ApiClient } from "../api";
import type { paths } from "./schema";

/**
 * Response types come through openapi-fetch's `MethodResponse`, so they match what
 * `req()` returns at runtime (it widens readonly tuples). Request bodies come
 * straight from the schema.
 */
type Res<M extends "get" | "post" | "patch", P extends ClientPathsWithMethod<ApiClient, M>> = MethodResponse<ApiClient, M, P>;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody: infer RB } ? (RB extends { content: { "application/json": infer B } } ? B : never) : never;

export type Me = Res<"get", "/v1/me">["data"];
export type Merchant = Res<"get", "/v1/merchant">["data"];
export type MerchantSettings = Merchant["settings"];
export type MerchantSettingsPatch = Body<"/v1/merchant/settings", "patch">;

export type Brand = Res<"get", "/v1/brands">["data"][number];
export type BrandCreate = Body<"/v1/brands", "post">;
export type BrandPatch = Body<"/v1/brands/{id}", "patch">;

export type Outlet = Res<"get", "/v1/outlets">["data"][number];
export type OutletCreate = Body<"/v1/outlets", "post">;
export type OutletPatch = Body<"/v1/outlets/{id}", "patch">;
/** Hours as sent: `{ mon: [["11:00", "22:00"]], ... }`. */
export type OutletHours = NonNullable<OutletCreate["hours"]>;
/** Hours as received (tuples widened to arrays). */
export type OutletHoursRead = Outlet["hours"];

export type Station = Res<"get", "/v1/outlets/{id}/stations">["data"][number];
export type StationCreate = Body<"/v1/stations", "post">;
export type StationPatch = Body<"/v1/stations/{id}", "patch">;

export type Staff = Res<"get", "/v1/staff">["data"][number];
export type StaffCreate = Body<"/v1/staff", "post">;
export type StaffPatch = Body<"/v1/staff/{id}", "patch">;

export type AuditPage = Res<"get", "/v1/audit">;
export type AuditEntry = AuditPage["data"][number];
