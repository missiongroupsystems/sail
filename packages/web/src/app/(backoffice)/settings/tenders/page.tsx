import { redirect } from "next/navigation";

/** The screen is called Payment methods now; old links and bookmarks still arrive. */
export default function TendersRedirect() {
  redirect("/settings/payment-methods");
}
