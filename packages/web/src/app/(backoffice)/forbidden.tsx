import { LinkButton, PageHeader } from "@sail/ui";
import { headers } from "next/headers";
import { req } from "@/lib/api";
import { PATH_HEADER } from "@/lib/cookies";
import { pageMinRole } from "@/lib/nav";
import { serverApi } from "@/lib/api.server";
import { ROLE_LABEL } from "@/components/backoffice/labels";

/** A page the person's role may not read: the register refused it (403), so say so and offer the way back. */
export default async function Forbidden() {
  const me = await req((await serverApi()).GET("/v1/me")).catch(() => null);
  const role = me?.data.role;
  // The page's own minimum role, as the register's rule for it; a page that names none says so without one.
  const min = pageMinRole((await headers()).get(PATH_HEADER));
  const label = min ? ROLE_LABEL[min] ?? min : null;
  const needs = label ? `This page needs ${/^[AEIOU]/.test(label) ? "an" : "a"} ${label}${min === "admin" ? "" : " or above"}.` : "This page needs a higher role than yours.";
  const ask = min === "admin" ? "Ask an Admin if you need what is on it." : "Ask a Manager or an Admin if you need what is on it.";
  return (
    <>
      <PageHeader title="This page needs a higher role" />
      <div className="flex max-w-[560px] flex-col items-start gap-4">
        <p className="text-body text-ink-2">
          {role ? `You are signed in with the ${ROLE_LABEL[role] ?? role} role. ` : ""}{needs} {ask}
        </p>
        <LinkButton href="/today" variant="primary">
          Go to Today
        </LinkButton>
      </div>
    </>
  );
}
