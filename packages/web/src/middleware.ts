import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/cookies";

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
  if (pathname === "/setup" || pathname === "/set-password") return NextResponse.next();
  if (!signedIn) {
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except API routes, Next internals, static files and the POS placeholder (which gets PIN sign-in later).
  matcher: ["/((?!api/|_next/|pos|favicon.ico|.*\\..*).*)"],
};
