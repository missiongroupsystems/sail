import { NextResponse, type NextRequest } from "next/server";
import { LINK_OUTLET_HEADER, PATH_HEADER, SESSION_COOKIE } from "@/lib/cookies";

/**
 * Presence check only: the register validates the token on every call. Signed-out
 * visitors go to /login; signed-in visitors never see /login.
 */
export function middleware(request: NextRequest) {
  const signedIn = request.cookies.has(SESSION_COOKIE);
  const { pathname } = request.nextUrl;

  if (pathname === "/login") {
    // The register ended the session (signed out elsewhere, access revoked, password reset): drop the stale cookie,
    // or the visitor would bounce between /login and /today.
    if (request.nextUrl.searchParams.has("expired")) {
      const res = NextResponse.next();
      res.cookies.delete(SESSION_COOKIE);
      return res;
    }
    return signedIn ? NextResponse.redirect(new URL("/today", request.url)) : NextResponse.next();
  }
  // First-run setup and invitation or reset links are for people who are not signed in yet.
  if (pathname === "/setup" || pathname === "/set-password" || pathname === "/forgot-password") return NextResponse.next();
  if (!signedIn) {
    const login = new URL("/login", request.url);
    // The deep link keeps its query (a report's date, a filter), so signing in lands where the link pointed.
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }
  // The page's path, for the refusal page to name the role it needs (forbidden.tsx has no other way to know it).
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, pathname);
  // A link's outlet, for the scope to follow when it is another brand's (see `followLink`). Only on a page opened from
  // the address (a shared link): a refresh after choosing another brand keeps the old outlet in the address a moment.
  headers.delete(LINK_OUTLET_HEADER);
  const outlet = request.nextUrl.searchParams.get("outlet");
  if (outlet && !request.headers.has("rsc")) headers.set(LINK_OUTLET_HEADER, outlet);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except API routes, Next internals, static files, the POS and the kitchen display (paired stations, not back-office sign-in).
  matcher: ["/((?!api/|_next/|pos|kds|favicon.ico|.*\\..*).*)"],
};
