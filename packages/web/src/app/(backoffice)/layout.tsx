import { LocaleProvider } from "@sail/ui";
import type { ReactNode } from "react";
import { getScope, getTheme, orSignIn, requireApi, scopeLists } from "@/lib/api.server";
import { req } from "@/lib/api";
import { merchantLocale } from "@/lib/locale";
import { QueryProvider } from "@/lib/query";
import { SessionProvider } from "@/lib/session-context";
import { Shell } from "@/components/Shell";

/**
 * The back-office frame: scope picker and left navigation, user menu,
 * content. Everything here comes from the register through the session's token.
 */
export default async function BackofficeLayout({ children }: { children: ReactNode }) {
  const api = await requireApi();
  const [me, merchant, { brands, outlets }] = await orSignIn(
    Promise.all([req(api.GET("/v1/me")), req(api.GET("/v1/merchant")), scopeLists()]),
  );
  const [scope, theme] = await Promise.all([getScope(), getTheme()]);

  return (
    <QueryProvider>
      <SessionProvider value={{ me: me.data, merchant: merchant.data, scope }}>
        <LocaleProvider settings={merchantLocale(merchant.data.settings)}>
          <Shell me={me.data} merchant={merchant.data} brands={brands} outlets={outlets} scope={scope} theme={theme}>
            {children}
          </Shell>
        </LocaleProvider>
      </SessionProvider>
    </QueryProvider>
  );
}
