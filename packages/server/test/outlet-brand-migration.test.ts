import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { migrationsFolder, runMigrations } from "../src/db/migrate.js";

/**
 * Migration 0057 gives every outlet the one brand it trades as, from what the outlet already has. These tests build
 * a database as it was before the migration (the journal up to 0056), put outlets in it, and migrate it forward.
 */
const admin = postgres(inject("pgAdminUrl"), { max: 1, onnotice: () => {} });
const port = inject("pgPort");
const before = `pre57_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const made: string[] = [];
let oldFolder = "";

beforeAll(async () => {
  // The same migrations, with a journal that stops before 0057.
  const folder = migrationsFolder();
  oldFolder = mkdtempSync(join(tmpdir(), "sail-pre57-"));
  cpSync(folder, oldFolder, { recursive: true });
  const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === "0057_outlet_brand");
  expect(at, "0057_outlet_brand is in the journal").toBeGreaterThan(0);
  writeFileSync(join(oldFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));
  await admin.unsafe(`create database ${before}`);
  const sql = postgres(`postgres://postgres@127.0.0.1:${port}/${before}`, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: oldFolder });
    const [col] = await sql`select 1 from information_schema.columns where table_name = 'outlets' and column_name = 'brand_id'`;
    expect(col, "the database is from before the migration").toBeUndefined();
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 240_000);

afterAll(async () => {
  for (const name of [...made, before]) await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end({ timeout: 2 });
  if (oldFolder) rmSync(oldFolder, { recursive: true, force: true });
});

/** A copy of the database from before the migration, to fill and then migrate. */
async function oldDatabase() {
  const name = `m57_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.unsafe(`create database ${name} template ${before}`);
  made.push(name);
  const url = `postgres://postgres@127.0.0.1:${port}/${name}`;
  return { url, sql: postgres(url, { max: 1, onnotice: () => {} }) };
}

type Sql = ReturnType<typeof postgres>;
const id = () => randomUUID();

async function merchant(sql: Sql, name: string, brandNames: string[]) {
  const merchantId = id();
  await sql`insert into merchants (id, name) values (${merchantId}, ${name})`;
  const brands: Record<string, string> = {};
  let n = 0;
  for (const b of brandNames) {
    brands[b] = id();
    // Created a minute apart, so "the oldest brand" is the first named.
    await sql`insert into brands (id, merchant_id, name, created_at) values (${brands[b]}, ${merchantId}, ${b}, now() - interval '1 day' + make_interval(mins => ${n++}))`;
  }
  return { merchantId, brands };
}
async function outlet(sql: Sql, merchantId: string, name: string, archived = false) {
  const outletId = id();
  await sql`insert into outlets (id, merchant_id, name, archived_at) values (${outletId}, ${merchantId}, ${name}, ${archived ? new Date() : null})`;
  return outletId;
}
async function station(sql: Sql, merchantId: string, outletId: string, brandId: string | null, kind: "pos" | "display" = "pos") {
  const stationId = id();
  await sql`insert into stations (id, merchant_id, outlet_id, brand_id, name, kind) values (${stationId}, ${merchantId}, ${outletId}, ${brandId}, 'Till', ${kind})`;
  return stationId;
}
async function link(sql: Sql, merchantId: string, outletId: string, brandId: string, channel: "pos" | "scan_to_order" = "pos") {
  const menuId = id();
  await sql`insert into menus (id, merchant_id, brand_id, name) values (${menuId}, ${merchantId}, ${brandId}, 'Menu')`;
  const linkId = id();
  await sql`insert into channel_links (id, merchant_id, channel, outlet_id, brand_id, menu_id) values (${linkId}, ${merchantId}, ${channel}, ${outletId}, ${brandId}, ${menuId})`;
  return linkId;
}
let orderNo = 0;
/**
 * Orders of a brand at an outlet. Every order names the channel link it came through; an outlet whose orders have to
 * decide is one whose own links are gone, so these orders name a link kept at another outlet.
 */
async function order(sql: Sql, merchantId: string, outletId: string, brandId: string, linkId: string, count = 1) {
  for (let i = 0; i < count; i++) {
    await sql`insert into orders (id, merchant_id, outlet_id, brand_id, channel_link_id, channel, order_type, order_no, business_date, tax_mode, tax_rounding, tax_rates)
      values (${id()}, ${merchantId}, ${outletId}, ${brandId}, ${linkId}, 'pos', 'takeaway', ${`T-${++orderNo}`}, '2026-11-20', 'exclusive', 'per_line', '[]'::jsonb)`;
  }
}
const brandOf = async (sql: Sql, outletId: string) => (await sql<{ brand_id: string }[]>`select brand_id from outlets where id = ${outletId}`)[0]!.brand_id;

describe("migration 0057: every outlet gets its one brand", () => {
  it("decides by channel links, then stations, then the brand most orders carry, then the merchant's only brand; stations follow their outlet", async () => {
    const { url, sql } = await oldDatabase();
    try {
      const two = await merchant(sql, "Two brands", ["Noodles", "Coffee"]);
      const { Noodles, Coffee } = two.brands as { Noodles: string; Coffee: string };
      const m = two.merchantId;

      // a. Its channel links, even with a station and orders of the other brand.
      const byLinks = await outlet(sql, m, "By links");
      const coffeeLink = await link(sql, m, byLinks, Coffee, "pos");
      await link(sql, m, byLinks, Coffee, "scan_to_order");
      const strayStation = await station(sql, m, byLinks, Noodles);
      await order(sql, m, byLinks, Noodles, coffeeLink, 3);
      // b. Its stations, with no channel link; a station without a brand and a kitchen display do not vote.
      const byStations = await outlet(sql, m, "By stations");
      await station(sql, m, byStations, Noodles);
      const blank = await station(sql, m, byStations, null);
      const display = await station(sql, m, byStations, null, "display");
      await order(sql, m, byStations, Coffee, coffeeLink, 5);
      // c. The brand most of its orders carry.
      const byOrders = await outlet(sql, m, "By orders");
      await order(sql, m, byOrders, Coffee, coffeeLink, 3);
      await order(sql, m, byOrders, Noodles, coffeeLink, 1);
      // An archived outlet with nothing under it: nobody trades from it, so it takes the merchant's oldest brand.
      const closed = await outlet(sql, m, "Closed long ago", true);

      // d. The merchant's only brand; and its only brand that is not archived.
      const one = await merchant(sql, "One brand", ["Solo"]);
      const empty = await outlet(sql, one.merchantId, "Empty");
      const retired = await merchant(sql, "One live brand", ["Old name", "New name"]);
      await sql`update brands set archived_at = now() where id = ${retired.brands["Old name"]!}`;
      const renamed = await outlet(sql, retired.merchantId, "Renamed");

      const notices: string[] = [];
      const forward = postgres(url, { max: 1, prepare: false, onnotice: (n) => notices.push(String(n.message)) });
      try {
        await migrate(drizzle(forward), { migrationsFolder: migrationsFolder() });
      } finally {
        await forward.end({ timeout: 5 });
      }

      expect(await brandOf(sql, byLinks)).toBe(Coffee);
      expect(await brandOf(sql, byStations)).toBe(Noodles);
      expect(await brandOf(sql, byOrders)).toBe(Coffee);
      expect(await brandOf(sql, closed)).toBe(Noodles);
      expect(await brandOf(sql, empty)).toBe(one.brands["Solo"]);
      expect(await brandOf(sql, renamed)).toBe(retired.brands["New name"]);

      // Every station is on its outlet's brand: the stray one, the blank one and the display.
      const stations = await sql<{ id: string; brand_id: string | null }[]>`select id, brand_id from stations where id in ${sql([strayStation, blank, display])}`;
      expect(Object.fromEntries(stations.map((s) => [s.id, s.brand_id]))).toEqual({ [strayStation]: Coffee, [blank]: Noodles, [display]: Noodles });
      // Orders from before keep the brand they were taken under.
      expect((await sql<{ n: number }[]>`select count(*)::int as n from orders where outlet_id = ${byLinks} and brand_id = ${Noodles}`)[0]!.n).toBe(3);
      // The migration says how many outlets each rule decided.
      const said = notices.find((n) => n.startsWith("outlet brands:")) ?? "";
      for (const part of ["1 by its channel links", "1 by its stations", "1 by its orders", "2 by the merchant's only brand", "1 by archived and empty: the merchant's oldest brand"]) expect(said).toContain(part);

      // The column is required, and the rules hold from here on.
      await expect(sql`insert into outlets (id, merchant_id, name) values (${id()}, ${m}, 'No brand')`).rejects.toThrow(/brand_id/);
      await expect(sql`insert into outlets (id, merchant_id, brand_id, name) values (${id()}, ${m}, ${one.brands["Solo"]!}, 'Another merchant''s brand')`).rejects.toThrow(/outlets_brand_id_same_merchant/);
      await expect(station(sql, m, byLinks, Noodles)).rejects.toThrow(/belongs to brand/);
      await expect(link(sql, m, byStations, Coffee)).rejects.toThrow(/belongs to brand/);
      await expect(order(sql, m, byOrders, Noodles, coffeeLink)).rejects.toThrow(/belongs to brand/);
      const filled = await station(sql, m, byOrders, null);
      expect((await sql<{ brand_id: string }[]>`select brand_id from stations where id = ${filled}`)[0]!.brand_id).toBe(Coffee);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  for (const [what, build, message] of [
    [
      "channel links of two brands",
      async (sql: Sql) => {
        const { merchantId: m, brands } = await merchant(sql, "Clash", ["A", "B"]);
        const o = await outlet(sql, m, "Two menus");
        await link(sql, m, o, brands["A"]!, "pos");
        await link(sql, m, o, brands["B"]!, "scan_to_order");
        await outlet(sql, m, "Fine one").then((fine) => station(sql, m, fine, brands["A"]!));
      },
      /Two menus \(outlet [0-9a-f-]+, merchant [0-9a-f-]+\): its channel links name 2 brands/,
    ],
    [
      "stations of two brands and no channel link",
      async (sql: Sql) => {
        const { merchantId: m, brands } = await merchant(sql, "Clash", ["A", "B"]);
        const o = await outlet(sql, m, "Two tills");
        await station(sql, m, o, brands["A"]!);
        await station(sql, m, o, brands["B"]!);
      },
      /Two tills \(.+\): its stations name 2 brands/,
    ],
    [
      "orders level between two brands",
      async (sql: Sql) => {
        const { merchantId: m, brands } = await merchant(sql, "Clash", ["A", "B"]);
        const kept = await link(sql, m, await outlet(sql, m, "Kept"), brands["A"]!);
        const o = await outlet(sql, m, "Level");
        await order(sql, m, o, brands["A"]!, kept, 2);
        await order(sql, m, o, brands["B"]!, kept, 2);
      },
      /Level \(.+\): its orders are level between 2 brands/,
    ],
    [
      "nothing to decide by at a merchant with two brands",
      async (sql: Sql) => {
        const { merchantId: m } = await merchant(sql, "Clash", ["A", "B"]);
        await outlet(sql, m, "Bare");
      },
      /Bare \(.+\): it has no channel link, station or order, and the merchant has 2 brands/,
    ],
  ] as const) {
    it(`stops and names the outlet: ${what}`, async () => {
      const { url, sql } = await oldDatabase();
      try {
        await build(sql);
        const refused = await runMigrations(url).then(
          () => null,
          (e: unknown) => e as { message: string; cause?: { message?: string; hint?: string } },
        );
        expect(refused, "the migration stopped").not.toBeNull();
        const text = `${refused!.message}\n${refused!.cause?.message ?? ""}`;
        expect(text).toMatch(/these outlets cannot be given theirs/);
        expect(text).toMatch(message);
        // Nothing was half done: the column is not there, and the migration can run again once the outlet is put right.
        const [col] = await sql`select 1 from information_schema.columns where table_name = 'outlets' and column_name = 'brand_id'`;
        expect(col).toBeUndefined();
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 120_000);
  }
});
