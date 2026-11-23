import { tx } from "./client.js";

/**
 * Runs a check with every outlet and every brand of the merchant in view, whatever the caller's scope, as the checks
 * before closing a shift do: a rule about the whole merchant must not pass because the caller cannot see a row.
 */
export async function withEveryOutlet<T>(check: () => Promise<T>): Promise<T> {
  const [was] = await tx()<{ outlets: string; brands: string }[]>`select current_setting('app.current_outlets', true) as outlets, current_setting('app.current_brands', true) as brands`;
  await tx()`select set_config('app.current_outlets', '*', true), set_config('app.current_brands', '*', true)`;
  try {
    return await check();
  } finally {
    await tx()`select set_config('app.current_outlets', ${was?.outlets ?? ""}, true), set_config('app.current_brands', ${was?.brands ?? ""}, true)`;
  }
}
