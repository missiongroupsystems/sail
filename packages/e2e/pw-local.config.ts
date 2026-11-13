// Local runs against servers already up (no webServer start): `playwright test -c pw-local.config.ts <spec>`.
import base from "./playwright.config";
export default { ...base, webServer: undefined };
