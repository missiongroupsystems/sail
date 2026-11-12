import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test as base, type Page, type Response } from "@playwright/test";

export const API = process.env.E2E_API_URL ?? "http://localhost:8080";
export const WEB = "http://localhost:3000";
export const GUEST = "http://localhost:3001";
/** The first-run stack: an API on an empty database and its own back office (playwright.config.ts). */
export const SETUP_API = process.env.E2E_SETUP_API_URL ?? "http://localhost:8091";
export const SETUP_WEB = "http://localhost:3002";

type DemoMerchant = { merchantId: string; brandId: string; outletId: string; stationId: string };

/**
 * What `dev:local` bootstrapped (written by packages/server/scripts/dev-local.ts): the Singapore demo merchant at the
 * top level and the EU VAT café (EUR, de-DE) under `eu`.
 */
export function devLocal(): DemoMerchant & { admin_password: string; eu: DemoMerchant } {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "../../server/.dev-local.json"), "utf8"));
}

export const SG_ADMIN = "admin@sail.local";
export const EU_ADMIN = "admin.eu@sail.local";

/** A register call as a back-office Admin would make it (signed in with email and password), by default the Singapore demo merchant's. */
export async function register<T>(method: string, path: string, body?: unknown, adminEmail = SG_ADMIN): Promise<T> {
  const token = await adminToken(adminEmail);
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const adminTokens = new Map<string, string>();
async function adminToken(email: string): Promise<string> {
  const cached = adminTokens.get(email);
  if (cached) return cached;
  const token = await signInToken(API, email, devLocal().admin_password);
  adminTokens.set(email, token);
  return token;
}

/** A back-office session token from the register's own sign-in, the path the web app uses. */
export async function signInToken(api: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${api}/v1/auth/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body = (await res.json()) as { data: { token: string } };
  if (!res.ok) throw new Error(`sign-in ${email} → ${res.status} ${JSON.stringify(body)}`);
  return body.data.token;
}

type Allowed = { status: number; url: RegExp; why: string };

/**
 * Every test watches its pages: a console error, or a response of 400 or more from the register or the apps, fails
 * the test unless the test declared it expected (a wrong PIN on purpose, say). This is what catches a refused
 * permission or a duplicate payment call that the screen itself shrugs off.
 */
export const test = base.extend<{ watch: { allow: (a: Allowed) => void; attach: (page: Page) => void } }>({
  watch: [
    async ({ page }, use, testInfo) => {
      const problems: string[] = [];
      const allowed: Allowed[] = [];
      const attach = (p: Page) => {
        p.on("console", (m) => {
          if (m.type() !== "error") return;
          // The browser logs every 4xx/5xx response as a console error too; the response handler judges those.
          if (/Failed to load resource: the server responded with a status of \d+/.test(m.text())) return;
          problems.push(`console error on ${p.url()}: ${m.text().slice(0, 400)}`);
        });
        p.on("pageerror", (e) => problems.push(`uncaught on ${p.url()}: ${e.message}`));
        p.on("response", (r: Response) => {
          if (r.status() < 400) return;
          const url = r.url();
          if (![API, WEB, GUEST, SETUP_API, SETUP_WEB].some((origin) => url.startsWith(origin))) return;
          if (allowed.some((a) => a.status === r.status() && a.url.test(url))) return;
          problems.push(`HTTP ${r.status()} ${r.request().method()} ${url}`);
        });
      };
      attach(page);
      await use({ allow: (a) => allowed.push(a), attach });
      if (testInfo.status === testInfo.expectedStatus) expect(problems, "console errors and failed requests").toEqual([]);
      else if (problems.length) await testInfo.attach("console errors and failed requests", { body: problems.join("\n"), contentType: "text/plain" });
    },
    { auto: true },
  ],
});

export { expect };

/** WCAG 2 contrast ratio of an element's text colour against the first opaque background behind it. */
export async function textContrast(page: Page, selector: string): Promise<{ ratio: number; color: string; background: string }> {
  return page.locator(selector).first().evaluate((el) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) throw new Error(`Unexpected colour ${c}`);
      const [r, g, b, a = 1] = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: r!, g: g!, b: b!, a };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const color = getComputedStyle(el).color;
    let node: Element | null = el;
    let background = "rgb(255, 255, 255)";
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (parse(bg).a > 0.5) {
        background = bg;
        break;
      }
      node = node.parentElement;
    }
    const [l1, l2] = [lum(parse(color)), lum(parse(background))].sort((a, b) => b - a);
    return { ratio: (l1! + 0.05) / (l2! + 0.05), color, background };
  });
}

/** Tap digits on a keypad (the PIN pad or an amount pad). */
export async function keyIn(page: Page, group: string, digits: string) {
  const pad = page.getByRole("group", { name: group }).last();
  for (const d of digits) await pad.getByRole("button", { name: d, exact: true }).click();
}

/** Pair the POS on this page to a demo merchant's station with a fresh code, then sign in with a PIN. */
export async function pairAndSignIn(page: Page, pin: string, merchant: "sg" | "eu" = "sg") {
  const { stationId } = merchant === "eu" ? devLocal().eu : devLocal();
  const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {}, merchant === "eu" ? EU_ADMIN : SG_ADMIN);
  await page.goto(`${WEB}/pos`);
  // The first visit compiles the POS bundle in the dev server.
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText("tap “Pair an iPad”")).toBeVisible();
  await keyIn(page, "PIN keys", data.code);
  await page.getByRole("button", { name: "Pair this iPad" }).click();
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  await keyIn(page, "PIN keys", pin);
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
}
