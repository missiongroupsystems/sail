import { LocaleProvider } from "@sail/ui";
import type { ReactNode } from "react";
import { getScope, getTheme, orSignIn, requireApi } from "@/lib/api.server";
import { req } from "@/lib/api";
import { merchantLocale } from "@/lib/locale.server";
import { QueryProvider } from "@/lib/query";
import { SessionProvider } from "@/lib/session-context";
import { Shell } from "@/components/Shell";

/**
 * The back-office frame (design 3.2): scope picker and left navigation, user menu,
 * content. Everything here comes from the register through the session's token.
 */
export default async function BackofficeLayout({ children }: { children: ReactNode }) {
  const api = await requireApi();
  const [me, merchant, brands, outlets] = await orSignIn(
    Promise.all([req(api.GET("/v1/me")), req(api.GET("/v1/merchant")), req(api.GET("/v1/brands")), req(api.GET("/v1/outlets"))]),
  );
  const [scope, theme, locale] = await Promise.all([getScope(), getTheme(), merchantLocale(merchant.data.settings)]);

  return (
    <QueryProvider>
      <SessionProvider value={{ me: me.data, merchant: merchant.data, scope }}>
        <LocaleProvider settings={locale}>
          <Shell me={me.data} merchant={merchant.data} brands={brands.data} outlets={outlets.data} scope={scope} theme={theme}>
            {children}
          </Shell>
        </LocaleProvider>
      </SessionProvider>
    </QueryProvider>
  );
}
