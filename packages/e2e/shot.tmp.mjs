import { chromium } from "@playwright/test";
const [,, out, ...paths] = process.argv;
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto("http://localhost:3000/login");
await p.getByLabel("Email").fill("admin@sail.local");
await p.getByLabel("Password").fill("sail-demo-password");
await p.getByRole("button", { name: "Sign in" }).click();
await p.waitForURL("**/today", { timeout: 120000 });
for (const path of paths) { await p.goto("http://localhost:3000" + path); await p.waitForTimeout(2500); await p.screenshot({ path: `${out}/${path.replaceAll("/", "_")}.png` }); }
await b.close();
