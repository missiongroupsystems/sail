import type { Locator, Page } from "@playwright/test";
import { API, expect, register, shot, signInToken, test, WEB } from "./fixtures";

/**
 * A read-only sheet's controls all read as one disabled grammar: the product sheet's "Attach a modifier group…" picker
 * looked darker than the disabled fields around it for a Manager in the Day theme (its text, chevron and fill now match).
 */

async function managerSignIn(page: Page) {
  const suffix = `manager${String(Date.now()).slice(-6)}`;
  const email = `${suffix}@sail.local`;
  const password = `quiet harbour lantern ${String(Date.now()).slice(-4)} round`;
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Read Only ${suffix}`, email, role: "manager" });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  await signInToken(API, email, password);
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

/** What the eye compares: the visible text's colour and weight, the icon's colour, the fill, the border and opacity. */
async function look(control: Locator) {
  return control.evaluate((el) => {
    let opacity = 1;
    for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const text = Array.from(el.querySelectorAll<HTMLElement>("*")).find((n) => n.childNodes.length && Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim())) ?? (el as HTMLElement);
    const textStyle = getComputedStyle(el instanceof HTMLInputElement ? el : text);
    const svg = el.querySelector("svg") ?? el.parentElement?.querySelector("svg");
    const s = getComputedStyle(el);
    return { text: el instanceof HTMLInputElement ? el.value : text.textContent, color: textStyle.color, weight: textStyle.fontWeight, opacity, background: s.backgroundColor, border: s.borderColor, icon: svg ? getComputedStyle(svg).color : null };
  });
}

test("a Manager's read-only product sheet: the modifier-group picker looks like the other disabled fields, Day and Service", async ({ page }) => {
  test.setTimeout(300_000);
  await managerSignIn(page);
  await page.goto(`${WEB}/menu/products`);
  await page.getByRole("grid").getByRole("row").nth(1).click();
  const sheet = page.getByRole("dialog");
  const picker = sheet.getByRole("button", { name: /Attach a modifier group/ });
  await expect(picker).toBeDisabled();
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    // Colours ease between themes; read once they have settled.
    await page.waitForTimeout(400);
    const name = await look(sheet.getByRole("textbox", { name: "Name", exact: true }));
    const otherSelect = await look(sheet.getByRole("button", { name: /Category/ }).first());
    const attach = await look(picker);
    const ink = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ink-disabled)";
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(name.color, `${theme}: a disabled field's text`).toBe(ink);
    expect(attach.color, `${theme}: the picker's placeholder`).toBe(ink);
    expect(attach.icon, `${theme}: the picker's chevron`).toBe(ink);
    expect(otherSelect.icon, `${theme}: another disabled select's chevron`).toBe(ink);
    expect({ weight: attach.weight, opacity: attach.opacity, background: attach.background, border: attach.border }).toEqual({ weight: name.weight, opacity: name.opacity, background: name.background, border: name.border });
    // Every line of text inside the disabled selects, a selected item's description included ("Follows the default
    // class if it changes." under the tax class).
    const selectInks = await sheet.locator("button[data-disabled][aria-haspopup]").evaluateAll((els) =>
      els.flatMap((el) => Array.from(el.querySelectorAll("*")).filter((n) => Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim())).map((n) => `${n.textContent}: ${getComputedStyle(n).color}`)),
    );
    expect(selectInks.length).toBeGreaterThan(2);
    for (const line of selectInks) expect(line, `${theme}: text in a disabled select`).toMatch(new RegExp(`: ${ink.replace(/[()]/g, "\\$&")}$`));
    // The tags field (chips in a field) has the same fill and no border.
    const tags = await sheet.locator("[data-tag]").first().evaluate((el) => {
      const field = el.closest(".sail-field")!;
      return { background: getComputedStyle(field).backgroundColor, border: getComputedStyle(field).borderColor };
    });
    expect(tags, `${theme}: the tags field`).toEqual({ background: name.background, border: name.border });
    // An empty disabled field's placeholder too.
    const placeholders = await sheet.locator("input:disabled[placeholder]").evaluateAll((els) => els.filter((e) => !(e as HTMLInputElement).value && (e as HTMLInputElement).placeholder).map((e) => getComputedStyle(e, "::placeholder").color));
    for (const c of placeholders) expect(c, `${theme}: a disabled field's placeholder`).toBe(ink);
    // One cursor over a locked field, its inner input included (the tags field's input had cursor:auto), and no
    // instruction to type in a field that takes none ("Add a tag and press Enter").
    const inputs = await sheet.locator("input:disabled:not([type=checkbox]):not([type=radio]):not([type=hidden])").evaluateAll((els) => els.map((e) => ({ cursor: getComputedStyle(e).cursor, placeholder: (e as HTMLInputElement).placeholder, what: `${(e as HTMLInputElement).labels?.[0]?.textContent ?? e.getAttribute("aria-label") ?? ""} ${e.getAttribute("type") ?? ""}` })));
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i.cursor, `${theme}: ${i.what}`).toBe("not-allowed");
    for (const i of inputs) expect(i.placeholder, `${theme}: a disabled input's placeholder`).not.toMatch(/^(Add|Type|Enter|Search)\b/);
    await picker.scrollIntoViewIfNeeded();
    await shot(page, test.info().outputPath(`product-readonly-${theme}.png`));
  }
});
