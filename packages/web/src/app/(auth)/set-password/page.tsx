import { SetPasswordForm } from "./SetPasswordForm";

export const metadata = { title: "Set your password" };

/** Where invitation and reset links land. The token is in the link's fragment, read in the browser. */
export default function SetPasswordPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title text-ink">Set your password</h1>
        <p className="mt-1 text-ink-2">At least 12 characters. A few unrelated words work well.</p>
      </div>
      <SetPasswordForm />
    </div>
  );
}
