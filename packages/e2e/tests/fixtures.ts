import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test as base, type Locator, type Page, type Response } from "@playwright/test";
import postgres from "postgres";

export const API = process.env.E2E_API_URL ?? "http://localhost:8080";
export const WEB = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const GUEST = process.env.E2E_GUEST_URL ?? "http://localhost:3001";
/** The first-run stack: an API on an empty database and its own back office (playwright.config.ts). */
export const SETUP_API = process.env.E2E_SETUP_API_URL ?? "http://localhost:8091";
export const SETUP_WEB = process.env.E2E_SETUP_WEB_URL ?? "http://localhost:3002";

type DemoMerchant = { merchantId: string; brandId: string; outletId: string; stationId: string };

/**
 * What `dev:local` bootstrapped (written by packages/server/scripts/dev-local.ts): the Singapore demo merchant at the
 * top level and the EU VAT café (EUR, de-DE) under `eu`, and the card-terminal simulator's address.
 */
export function devLocal(): DemoMerchant & { admin_password: string; payment_simulator: string; eu: DemoMerchant } {
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
export const test = base.extend<{ watch: { allow: (a: Allowed) => void; /** A console error or uncaught error the test expects, by its text. */ allowConsole: (text: RegExp) => void; attach: (page: Page) => void } }>({
  watch: [
    async ({ page }, use, testInfo) => {
      const problems: string[] = [];
      const allowed: Allowed[] = [];
      const allowedConsole: RegExp[] = [];
      const attach = (p: Page) => {
        p.on("console", (m) => {
          if (m.type() !== "error") return;
          // The browser logs every 4xx/5xx response as a console error too; the response handler judges those.
          if (/Failed to load resource: the server responded with a status of \d+/.test(m.text())) return;
          if (allowedConsole.some((r) => r.test(m.text()))) return;
          problems.push(`console error on ${p.url()}: ${m.text().slice(0, 4000)}`);
        });
        p.on("pageerror", (e) => {
          if (!allowedConsole.some((r) => r.test(e.message))) problems.push(`uncaught on ${p.url()}: ${e.message}`);
        });
        p.on("response", (r: Response) => {
          if (r.status() < 400) return;
          const url = r.url();
          if (![API, WEB, GUEST, SETUP_API, SETUP_WEB].some((origin) => url.startsWith(origin))) return;
          if (allowed.some((a) => a.status === r.status() && a.url.test(url))) return;
          problems.push(`HTTP ${r.status()} ${r.request().method()} ${url}`);
        });
      };
      attach(page);
      await use({ allow: (a) => allowed.push(a), allowConsole: (r) => allowedConsole.push(r), attach });
      if (testInfo.status === testInfo.expectedStatus) expect(problems, "console errors and failed requests").toEqual([]);
      else if (problems.length) await testInfo.attach("console errors and failed requests", { body: problems.join("\n"), contentType: "text/plain" });
    },
    { auto: true },
  ],
});

export { expect };

/**
 * A screenshot for the record that leaves the page alone. Playwright hides the text caret by writing
 * `caret-color: transparent !important` into every input's inline style for the shot, then restores it; on a page the
 * development server has not hydrated yet, React then finds a style the server never rendered and reports a hydration
 * mismatch (live-round5 M6 on /settings/merchant, 5 of 6 sandbox runs). `caret: "initial"` touches no element.
 */
export async function shot(target: Page | Locator, path: string): Promise<void> {
  await target.screenshot({ path, caret: "initial" });
}

/**
 * WCAG 2 contrast ratio of an element's text colour against the first opaque background behind it.
 * The element is looked up and read in one evaluation: a table replaces its body once after hydration, and an element
 * handle resolved a moment earlier can by then be detached, with empty computed colours.
 */
export async function textContrast(page: Page, selector: string): Promise<{ ratio: number; color: string; background: string }> {
  await page.locator(selector).first().waitFor({ state: "attached" });
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`No element matches ${sel}`);
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
  }, selector);
}

/**
 * On the close-shift checklist, leave every open item for the next shift once the register has answered each of its
 * reads (until then the primary button says "Checking the register…"). Each Leave open is found afresh, and each click
 * waits for its button to go: a left item loses its button, so a list of the buttons taken up front points past the end.
 * The checklist has four items, so four clicks at most.
 */
export async function leaveChecklistOpen(page: Page) {
  await expect(page.getByRole("button", { name: /^(Next: count the cash|Resolve or leave each item)$/ })).toBeVisible();
  const leave = page.getByRole("list", { name: "Before closing" }).getByRole("button", { name: "Leave open" });
  for (let i = 0; i < 4; i++) {
    const open = await leave.count();
    if (open === 0) break;
    await leave.first().click();
    await expect(leave).toHaveCount(open - 1);
  }
  await expect(leave).toHaveCount(0);
}

/** Tap digits on a keypad (the PIN pad or an amount pad). */
export async function keyIn(page: Page, group: string, digits: string) {
  const pad = page.getByRole("group", { name: group }).last();
  for (const d of digits) await pad.getByRole("button", { name: d, exact: true }).click();
}

/**
 * Enter a pairing code on the POS pairing screen. The code has a text field of its own (not the PIN pad the next
 * screen uses) and pairs at its sixth digit, so there is no button to press (polish-pilot A6).
 */
export async function enterPairingCode(page: Page, code: string) {
  await page.getByRole("textbox", { name: "Pairing code from the back office" }).fill(code);
}

/** Pair the POS on this page to a demo merchant's station with a fresh code, then sign in with a PIN. */
export async function pairAndSignIn(page: Page, pin: string, merchant: "sg" | "eu" = "sg", station?: string) {
  const stationId = station ?? (merchant === "eu" ? devLocal().eu : devLocal()).stationId;
  const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {}, merchant === "eu" ? EU_ADMIN : SG_ADMIN);
  await page.goto(`${WEB}/pos`);
  // The first visit compiles the POS bundle in the dev server.
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText("tap “Pair an iPad”")).toBeVisible();
  await enterPairingCode(page, data.code);
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  await keyIn(page, "PIN keys", pin);
  // A station with no brand opens on its own message instead of the screens (polish-pilot A2).
  await expect(page.getByRole("navigation", { name: "Destinations" }).or(page.getByRole("heading", { name: "This station has no brand" }))).toBeVisible();
}

/**
 * The development database itself, for a state no register call can make any more (a POS station saved without a
 * brand before brands were required). `dev:local` writes its address to .dev-local.json. Close it with `.end()`.
 */
export function devDatabase() {
  const { database_url } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../server/.dev-local.json"), "utf8")) as { database_url: string };
  return postgres(database_url, { max: 1, onnotice: () => {} });
}
