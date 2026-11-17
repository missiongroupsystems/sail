import { redirect } from "next/navigation";

/** The audit log is the back office's list of changes; an old link to /changes lands there. */
export default function Page() {
  redirect("/audit");
}
