import { req } from "@/lib/api";
import { getSessionToken, serverApi } from "@/lib/api.server";
import { SetPasswordForm } from "./SetPasswordForm";

export const metadata = { title: "Set your password" };

/**
 * Where invitation and reset links land. The token is in the link's fragment, read in the browser. Opened in a browser
 * that is signed in, the page says so: setting the password signs that person out and signs in the link's owner.
 */
export default async function SetPasswordPage() {
  const signedIn = (await getSessionToken()) ? await req((await serverApi()).GET("/v1/me")).catch(() => null) : null;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-[24px] leading-[1.25] font-semibold tracking-[-0.02em] text-ink">Set your password</h1>
        <p className="mt-2 text-[14px] leading-5 text-ink-2">At least 12 characters. A few unrelated words work well.</p>
      </div>
      <SetPasswordForm signedInAs={signedIn ? signedIn.data.name : null} />
    </div>
  );
}
