import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { AmountSchema, currencyExponent, TaxModeSchema, TaxRoundingSchema } from "@sail/shared";
import { db } from "../db/client.js";
import { brands, displayDestinations, merchantSettings, merchants, outlets, stations } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z, untrusted } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { outletVisible } from "../auth/principal.js";
import { isCashRoundingIncrement, isValidLocale, isValidTimeZone, validDenominations } from "../lib/locale.js";

/* ---- Schemas ----------------------------------------------------------- */

export const MerchantSettingsSchema = z.object({
  tax_mode: TaxModeSchema,
  tax_rounding: TaxRoundingSchema,
  /** Minor units; null = off. */
  cash_rounding_increment: z.number().int().nullable(),
  /** Notes and coins for the POS cash counter, largest first, in minor units. */
  cash_denominations: z.array(AmountSchema.min(1)),
  /** Closing a shift more than this many minor units out needs a variance reason. */
  cash_variance_threshold: AmountSchema,
  business_day_cutoff: z.string(),
  timezone: z.string(),
  /** ISO 4217. Fixed once the merchant exists. */
  currency: z.string(),
  /** Decimal places of the currency's minor unit (JPY 0, EUR 2, KWD 3): divide stored amounts by 10^exponent to display them. */
  currency_exponent: z.number().int(),
  /** BCP 47. */
  locale: z.string(),
  business_registration_label: z.string(),
  tax_registration_label: z.string(),
  receipt_footer: z.string().nullable(),
  receipt_show_outlet_phone: z.boolean(),
  busy_mode_threshold: z.number().int(),
  /** Kitchen display: a ticket's elapsed time turns amber after this many minutes... */
  kitchen_warn_minutes: z.number().int(),
  /** ...and red after this many. */
  kitchen_late_minutes: z.number().int(),
});
export const MerchantSchema = z.object({ id: z.string(), name: z.string(), settings: MerchantSettingsSchema });
/** What a guest surface (the ordering app, a digital receipt) needs to format amounts, dates and times. */
export const LocaleSettingsSchema = MerchantSettingsSchema.pick({ currency: true, currency_exponent: true, locale: true, timezone: true });
export async function localeSettingsFor(merchantId: string): Promise<z.infer<typeof LocaleSettingsSchema>> {
  const [s] = await db().select({ currency: merchantSettings.currency, locale: merchantSettings.locale, timezone: merchantSettings.timezone }).from(merchantSettings).where(eq(merchantSettings.merchantId, merchantId)).limit(1);
  if (!s) throw AppError.notFound("merchant");
  return { currency: s.currency, currency_exponent: currencyExponent(s.currency), locale: s.locale, timezone: s.timezone };
}
const SettingsPatch = MerchantSettingsSchema.omit({ currency_exponent: true }).partial().extend({ name: z.string().min(1).optional() });

export const BrandSchema = z.object({
  id: z.string(),
  name: z.string(),
  accent_color: z.string().nullable(),
  display_font: z.string().nullable(),
  logo_url: z.string().nullable(),
  legacy_id: z.string().nullable(),
  archived: z.boolean(),
});
const BrandInput = z.object({ id: z.uuid().optional(), name: z.string().min(1), accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), display_font: z.string().nullable().optional(), logo_url: z.string().nullable().optional(), legacy_id: z.string().nullable().optional() });
const BrandPatch = BrandInput.omit({ id: true }).partial().extend({ archived: z.boolean().optional() });

const HoursSchema = z.record(z.string(), z.array(z.tuple([z.string(), z.string()])));
export const OutletSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  business_registration_no: z.string().nullable(),
  tax_registration_no: z.string().nullable(),
  business_day_cutoff: z.string().nullable(),
  hours: HoursSchema,
  service_theme_from: z.string().nullable(),
  legacy_id: z.string().nullable(),
  archived: z.boolean(),
});
const OutletInput = z.object({
  id: z.uuid().optional(),
  name: z.string().min(1),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  business_registration_no: z.string().nullable().optional(),
  tax_registration_no: z.string().nullable().optional(),
  business_day_cutoff: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  hours: HoursSchema.optional(),
  service_theme_from: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  legacy_id: z.string().nullable().optional(),
});
const OutletPatch = OutletInput.omit({ id: true }).partial().extend({ archived: z.boolean().optional() });

export const StationSchema = z.object({
  id: z.string(),
  outlet_id: z.string(),
  name: z.string(),
  brand_id: z.string().nullable(),
  layout_id: z.string().nullable(),
  pay_before_firing: z.boolean(),
  seats_enabled: z.boolean(),
  home: z.enum(["floor", "takeaway"]),
  receipt_printer_id: z.string().nullable(),
  text_size: z.string(),
  /** `display`: a kitchen display, which shows and bumps tickets without a PIN. */
  kind: z.enum(["pos", "display"]),
  /** The kitchen display destinations a display station shows. */
  display_destination_ids: z.array(z.string()),
  paired: z.boolean(),
  device_label: untrusted(z.string().nullable()),
  archived: z.boolean(),
});
const StationInput = z.object({
  id: z.uuid().optional(),
  outlet_id: z.uuid(),
  name: z.string().min(1),
  brand_id: z.uuid().nullable().optional(),
  layout_id: z.uuid().nullable().optional(),
  pay_before_firing: z.boolean().optional(),
  seats_enabled: z.boolean().optional(),
  home: z.enum(["floor", "takeaway"]).optional(),
  receipt_printer_id: z.uuid().nullable().optional(),
  text_size: z.enum(["standard", "large"]).optional(),
  kind: z.enum(["pos", "display"]).optional(),
  display_destination_ids: z.array(z.uuid()).max(20).optional(),
});
const StationPatch = StationInput.omit({ id: true, outlet_id: true, kind: true }).partial().extend({ archived: z.boolean().optional() });

/* ---- Mappers ------------------------------------------------------------ */

export const toBrand = (b: typeof brands.$inferSelect) => ({ id: b.id, name: b.name, accent_color: b.accentColor, display_font: b.displayFont, logo_url: b.logoUrl, legacy_id: b.legacyId, archived: b.archivedAt != null });
export const toOutlet = (o: typeof outlets.$inferSelect) => ({
  id: o.id,
  name: o.name,
  address: o.address,
  phone: o.phone,
  business_registration_no: o.businessRegistrationNo,
  tax_registration_no: o.taxRegistrationNo,
  business_day_cutoff: o.businessDayCutoff,
  hours: o.hours,
  service_theme_from: o.serviceThemeFrom,
  legacy_id: o.legacyId,
  archived: o.archivedAt != null,
});
export const toStation = (s: typeof stations.$inferSelect) => ({
  id: s.id,
  outlet_id: s.outletId,
  name: s.name,
  brand_id: s.brandId,
  layout_id: s.layoutId,
  pay_before_firing: s.payBeforeFiring,
  seats_enabled: s.seatsEnabled,
  home: s.home,
  receipt_printer_id: s.receiptPrinterId,
  text_size: s.textSize,
  kind: s.kind,
  display_destination_ids: s.displayDestinationIds,
  paired: s.tokenHash != null,
  device_label: s.deviceLabel,
  archived: s.archivedAt != null,
});
const toSettings = (s: typeof merchantSettings.$inferSelect) => ({
  tax_mode: s.taxMode,
  tax_rounding: s.taxRounding,
  cash_rounding_increment: s.cashRoundingIncrement,
  cash_denominations: s.cashDenominations,
  cash_variance_threshold: s.cashVarianceThreshold,
  business_day_cutoff: s.businessDayCutoff,
  timezone: s.timezone,
  currency: s.currency,
  currency_exponent: currencyExponent(s.currency),
  locale: s.locale,
  business_registration_label: s.businessRegistrationLabel,
  tax_registration_label: s.taxRegistrationLabel,
  receipt_footer: s.receiptFooter,
  receipt_show_outlet_phone: s.receiptShowOutletPhone,
  busy_mode_threshold: s.busyModeThreshold,
  kitchen_warn_minutes: s.kitchenWarnMinutes,
  kitchen_late_minutes: s.kitchenLateMinutes,
});

/** Business-day inputs live in the service layer; re-exported here for the routes that import them from this module. */
import { businessDayInputs } from "../services/business-day.js";
export { businessDayInputs };

/** A display station shows destinations of its own outlet only; a POS station shows none. */
async function assertDestinations(st: typeof stations.$inferSelect) {
  const ids = [...new Set(st.displayDestinationIds)];
  if (ids.length === 0) return;
  if (st.kind !== "display") throw AppError.validation("Only a kitchen display station shows display destinations", { remedy: "Create a station of kind display for the kitchen screen." });
  const found = await db().select({ id: displayDestinations.id }).from(displayDestinations).where(and(inArray(displayDestinations.id, ids), eq(displayDestinations.outletId, st.outletId), isNull(displayDestinations.archivedAt)));
  if (found.length !== ids.length) throw AppError.notFound("kitchen display destination at this station's outlet");
}

/* ---- Routes -------------------------------------------------------------- */

export function orgRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "merchants.get", method: "get", path: "/v1/merchant", tags: ["organisation"], responses: { 200: jsonResponse(dataResponse(MerchantSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const [m] = await db().select().from(merchants).where(eq(merchants.id, p.merchantId)).limit(1);
    const [s] = await db().select().from(merchantSettings).where(eq(merchantSettings.merchantId, p.merchantId)).limit(1);
    if (!m || !s) throw AppError.notFound("merchant");
    return c.json({ data: { id: m.id, name: m.name, settings: toSettings(s) } }, 200);
  });

  defineOp(
    app,
    { op: "merchants.update_settings", method: "patch", path: "/v1/merchant/settings", tags: ["organisation"], request: { body: jsonBody(SettingsPatch) }, responses: { 200: jsonResponse(mutationResponse(MerchantSchema)), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const patch = c.req.valid("json");
      const [current] = await db().select({ currency: merchantSettings.currency }).from(merchantSettings).where(eq(merchantSettings.merchantId, p.merchantId)).limit(1);
      if (!current) throw AppError.notFound("merchant");
      if (patch.cash_rounding_increment != null && !isCashRoundingIncrement(patch.cash_rounding_increment)) throw AppError.validation("cash_rounding_increment must be 1, 2 or 5 times a power of ten, in minor units of the currency, or null to turn rounding off", { remedy: "For example 5 rounds CHF to 0.05; 100 rounds SEK to 1 krona." });
      if (patch.cash_denominations != null && !validDenominations(patch.cash_denominations)) throw AppError.validation("cash_denominations must be distinct positive amounts in minor units, largest first", { remedy: "For example [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5]." });
      if (patch.cash_variance_threshold != null && patch.cash_variance_threshold < 0) throw AppError.validation("cash_variance_threshold must be zero or more, in minor units of the currency", { remedy: "For example 500 asks for a reason when the drawer is more than 5.00 out in a 2-decimal currency." });
      if (patch.business_day_cutoff != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.business_day_cutoff)) throw AppError.validation("business_day_cutoff must be HH:MM (24-hour)", { remedy: "For example 04:00." });
      if (patch.timezone != null && !isValidTimeZone(patch.timezone)) throw AppError.validation(`Unknown time zone ${patch.timezone}`, { remedy: "Use an IANA zone such as Europe/Berlin." });
      if (patch.locale != null && !isValidLocale(patch.locale)) throw AppError.validation(`Unknown locale ${patch.locale}`, { remedy: "Use a BCP 47 tag such as en-GB or de-DE." });
      if (patch.busy_mode_threshold != null && (patch.busy_mode_threshold < 1 || patch.busy_mode_threshold > 999)) throw AppError.validation("busy_mode_threshold must be between 1 and 999 open orders");
      if (patch.kitchen_warn_minutes != null || patch.kitchen_late_minutes != null) {
        const [k] = await db().select({ warn: merchantSettings.kitchenWarnMinutes, late: merchantSettings.kitchenLateMinutes }).from(merchantSettings).where(eq(merchantSettings.merchantId, p.merchantId)).limit(1);
        const warn = patch.kitchen_warn_minutes ?? k!.warn;
        const late = patch.kitchen_late_minutes ?? k!.late;
        if (warn < 1 || late <= warn || late > 240) throw AppError.validation("kitchen_warn_minutes must be at least 1 and below kitchen_late_minutes, which is at most 240", { remedy: "For example 8 and 15: a ticket turns amber after 8 minutes and red after 15." });
      }
      if (patch.currency != null && patch.currency !== current.currency) throw AppError.validation(`The currency is ${current.currency} and cannot change`, { remedy: "Every stored amount is in this currency's minor units. Create a new merchant for another currency.", details: { currency: current.currency } });
      const { name, ...settings } = patch;
      if (name) await db().update(merchants).set({ name }).where(eq(merchants.id, p.merchantId));
      const [s] = await db()
        .update(merchantSettings)
        .set({
          ...(settings.tax_mode !== undefined && { taxMode: settings.tax_mode }),
          ...(settings.tax_rounding !== undefined && { taxRounding: settings.tax_rounding }),
          ...(settings.cash_rounding_increment !== undefined && { cashRoundingIncrement: settings.cash_rounding_increment }),
          ...(settings.cash_denominations !== undefined && { cashDenominations: settings.cash_denominations }),
          ...(settings.cash_variance_threshold !== undefined && { cashVarianceThreshold: settings.cash_variance_threshold }),
          ...(settings.business_day_cutoff !== undefined && { businessDayCutoff: settings.business_day_cutoff }),
          ...(settings.timezone !== undefined && { timezone: settings.timezone }),
          ...(settings.locale !== undefined && { locale: settings.locale }),
          ...(settings.business_registration_label !== undefined && { businessRegistrationLabel: settings.business_registration_label }),
          ...(settings.tax_registration_label !== undefined && { taxRegistrationLabel: settings.tax_registration_label }),
          ...(settings.receipt_footer !== undefined && { receiptFooter: settings.receipt_footer }),
          ...(settings.receipt_show_outlet_phone !== undefined && { receiptShowOutletPhone: settings.receipt_show_outlet_phone }),
          ...(settings.busy_mode_threshold !== undefined && { busyModeThreshold: settings.busy_mode_threshold }),
          ...(settings.kitchen_warn_minutes !== undefined && { kitchenWarnMinutes: settings.kitchen_warn_minutes }),
          ...(settings.kitchen_late_minutes !== undefined && { kitchenLateMinutes: settings.kitchen_late_minutes }),
          updatedAt: new Date(),
        })
        .where(eq(merchantSettings.merchantId, p.merchantId))
        .returning();
      const [m] = await db().select().from(merchants).where(eq(merchants.id, p.merchantId)).limit(1);
      if (!s || !m) throw AppError.notFound("merchant");
      const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "merchant.settings_updated", aggregate: { kind: "merchant", id: p.merchantId }, operationId: "merchants.update_settings", payload: patch, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
      await recordAudit(p, { action: "merchants.update_settings", targetKind: "merchant", targetId: p.merchantId, details: patch });
      return c.json({ data: { id: m.id, name: m.name, settings: toSettings(s) }, events: [ev], warnings: [] }, 200);
    },
  );

  /* Brands */
  defineOp(app, { op: "brands.list", method: "get", path: "/v1/brands", tags: ["organisation"], request: { query: z.object({ include_archived: z.enum(["true", "false"]).optional() }) }, responses: { 200: jsonResponse(listResponse(BrandSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const where = q.include_archived === "true" ? eq(brands.merchantId, p.merchantId) : and(eq(brands.merchantId, p.merchantId), isNull(brands.archivedAt));
    const rows = await db().select().from(brands).where(where).orderBy(asc(brands.name));
    return c.json({ data: rows.map(toBrand), next_cursor: null }, 200);
  });

  defineOp(app, { op: "brands.create", method: "post", path: "/v1/brands", tags: ["organisation"], request: { body: jsonBody(BrandInput) }, responses: { 201: jsonResponse(mutationResponse(BrandSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const body = c.req.valid("json");
    const [row] = await db().insert(brands).values({ id: body.id, merchantId: p.merchantId, name: body.name, accentColor: body.accent_color ?? null, displayFont: body.display_font ?? null, logoUrl: body.logo_url ?? null, legacyId: body.legacy_id ?? null }).returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "brand.created", aggregate: { kind: "brand", id: row!.id }, operationId: "brands.create", payload: toBrand(row!), correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "brands.create", targetKind: "brand", targetId: row!.id, details: { name: row!.name } });
    return c.json({ data: toBrand(row!), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "brands.update", method: "patch", path: "/v1/brands/{id}", tags: ["organisation"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(BrandPatch) }, responses: { 200: jsonResponse(mutationResponse(BrandSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) throw AppError.validation("Nothing to update");
    const [row] = await db()
      .update(brands)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.accent_color !== undefined && { accentColor: body.accent_color }),
        ...(body.display_font !== undefined && { displayFont: body.display_font }),
        ...(body.logo_url !== undefined && { logoUrl: body.logo_url }),
        ...(body.legacy_id !== undefined && { legacyId: body.legacy_id }),
        ...(body.archived !== undefined && { archivedAt: body.archived ? new Date() : null }),
      })
      .where(and(eq(brands.id, id), eq(brands.merchantId, p.merchantId)))
      .returning();
    if (!row) throw AppError.notFound("brand", id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "brand.updated", aggregate: { kind: "brand", id }, operationId: "brands.update", payload: body, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "brands.update", targetKind: "brand", targetId: id, details: body });
    return c.json({ data: toBrand(row), events: [ev], warnings: [] }, 200);
  });

  /* Outlets */
  defineOp(app, { op: "outlets.list", method: "get", path: "/v1/outlets", tags: ["organisation"], request: { query: z.object({ include_archived: z.enum(["true", "false"]).optional() }) }, responses: { 200: jsonResponse(listResponse(OutletSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const where = q.include_archived === "true" ? eq(outlets.merchantId, p.merchantId) : and(eq(outlets.merchantId, p.merchantId), isNull(outlets.archivedAt));
    // RLS already limits the rows to the caller's outlet scope.
    const rows = await db().select().from(outlets).where(where).orderBy(asc(outlets.name));
    return c.json({ data: rows.map(toOutlet), next_cursor: null }, 200);
  });

  defineOp(app, { op: "outlets.create", method: "post", path: "/v1/outlets", tags: ["organisation"], request: { body: jsonBody(OutletInput) }, responses: { 201: jsonResponse(mutationResponse(OutletSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const body = c.req.valid("json");
    const [row] = await db()
      .insert(outlets)
      .values({ id: body.id, merchantId: p.merchantId, name: body.name, address: body.address ?? null, phone: body.phone ?? null, businessRegistrationNo: body.business_registration_no ?? null, taxRegistrationNo: body.tax_registration_no ?? null, businessDayCutoff: body.business_day_cutoff ?? null, hours: body.hours ?? {}, serviceThemeFrom: body.service_theme_from ?? "18:00", legacyId: body.legacy_id ?? null })
      .returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "outlet.created", aggregate: { kind: "outlet", id: row!.id }, operationId: "outlets.create", payload: toOutlet(row!), correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "outlets.create", targetKind: "outlet", targetId: row!.id, details: { name: row!.name } });
    return c.json({ data: toOutlet(row!), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "outlets.update", method: "patch", path: "/v1/outlets/{id}", tags: ["organisation"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(OutletPatch) }, responses: { 200: jsonResponse(mutationResponse(OutletSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) throw AppError.validation("Nothing to update");
    const [row] = await db()
      .update(outlets)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.address !== undefined && { address: body.address }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.business_registration_no !== undefined && { businessRegistrationNo: body.business_registration_no }),
        ...(body.tax_registration_no !== undefined && { taxRegistrationNo: body.tax_registration_no }),
        ...(body.business_day_cutoff !== undefined && { businessDayCutoff: body.business_day_cutoff }),
        ...(body.hours !== undefined && { hours: body.hours }),
        ...(body.service_theme_from !== undefined && { serviceThemeFrom: body.service_theme_from }),
        ...(body.legacy_id !== undefined && { legacyId: body.legacy_id }),
        ...(body.archived !== undefined && { archivedAt: body.archived ? new Date() : null }),
      })
      .where(and(eq(outlets.id, id), eq(outlets.merchantId, p.merchantId)))
      .returning();
    if (!row) throw AppError.notFound("outlet", id);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "outlet.updated", aggregate: { kind: "outlet", id }, operationId: "outlets.update", payload: body, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "outlets.update", targetKind: "outlet", targetId: id, details: body });
    return c.json({ data: toOutlet(row), events: [ev], warnings: [] }, 200);
  });

  /* Stations */
  defineOp(app, { op: "stations.list", method: "get", path: "/v1/outlets/{id}/stations", tags: ["organisation"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(listResponse(StationSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    if (!(await outletVisible(p, id))) throw AppError.notFound("outlet", id);
    const rows = await db().select().from(stations).where(and(eq(stations.outletId, id), isNull(stations.archivedAt))).orderBy(asc(stations.name));
    return c.json({ data: rows.map(toStation), next_cursor: null }, 200);
  });

  defineOp(app, { op: "stations.create", method: "post", path: "/v1/stations", tags: ["organisation"], request: { body: jsonBody(StationInput) }, responses: { 201: jsonResponse(mutationResponse(StationSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const body = c.req.valid("json");
    const [outlet] = await db().select({ id: outlets.id }).from(outlets).where(eq(outlets.id, body.outlet_id)).limit(1);
    if (!outlet) throw AppError.notFound("outlet", body.outlet_id);
    const [row] = await db()
      .insert(stations)
      .values({ id: body.id, merchantId: p.merchantId, outletId: body.outlet_id, name: body.name, brandId: body.brand_id ?? null, layoutId: body.layout_id ?? null, payBeforeFiring: body.pay_before_firing ?? false, seatsEnabled: body.seats_enabled ?? false, home: body.home ?? "floor", receiptPrinterId: body.receipt_printer_id ?? null, textSize: body.text_size ?? "standard", kind: body.kind ?? "pos", displayDestinationIds: body.display_destination_ids ?? [] })
      .returning();
    await assertDestinations(row!);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: body.outlet_id, type: "station.created", aggregate: { kind: "station", id: row!.id }, operationId: "stations.create", payload: toStation(row!), correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, body.outlet_id) }, p);
    await recordAudit(p, { action: "stations.create", targetKind: "station", targetId: row!.id, outletId: body.outlet_id, details: { name: row!.name } });
    return c.json({ data: toStation(row!), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "stations.update", method: "patch", path: "/v1/stations/{id}", tags: ["organisation"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(StationPatch) }, responses: { 200: jsonResponse(mutationResponse(StationSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (Object.keys(body).length === 0) throw AppError.validation("Nothing to update");
    const [row] = await db()
      .update(stations)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.brand_id !== undefined && { brandId: body.brand_id }),
        ...(body.layout_id !== undefined && { layoutId: body.layout_id }),
        ...(body.pay_before_firing !== undefined && { payBeforeFiring: body.pay_before_firing }),
        ...(body.seats_enabled !== undefined && { seatsEnabled: body.seats_enabled }),
        ...(body.home !== undefined && { home: body.home }),
        ...(body.receipt_printer_id !== undefined && { receiptPrinterId: body.receipt_printer_id }),
        ...(body.text_size !== undefined && { textSize: body.text_size }),
        ...(body.display_destination_ids !== undefined && { displayDestinationIds: body.display_destination_ids }),
        ...(body.archived !== undefined && { archivedAt: body.archived ? new Date() : null }),
      })
      .where(and(eq(stations.id, id), eq(stations.merchantId, p.merchantId)))
      .returning();
    if (!row) throw AppError.notFound("station", id);
    if (body.display_destination_ids !== undefined) await assertDestinations(row);
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: row.outletId, type: "station.updated", aggregate: { kind: "station", id }, operationId: "stations.update", payload: body, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, row.outletId) }, p);
    await recordAudit(p, { action: "stations.update", targetKind: "station", targetId: id, outletId: row.outletId, details: body });
    return c.json({ data: toStation(row), events: [ev], warnings: [] }, 200);
  });
}
