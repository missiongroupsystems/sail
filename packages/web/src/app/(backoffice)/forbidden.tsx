import { LinkButton, PageHeader } from "@sail/ui";
import { req } from "@/lib/api";
import { serverApi } from "@/lib/api.server";
import { ROLE_LABEL } from "@/components/backoffice/labels";

/** A page the person's role may not read: the register refused it (403), so say so and offer the way back. */
export default async function Forbidden() {
  const me = await req((await serverApi()).GET("/v1/me")).catch(() => null);
  const role = me?.data.role;
  return (
    <>
      <PageHeader title="This page needs a higher role" />
      <div className="flex max-w-[560px] flex-col items-start gap-4">
        <p className="text-body text-ink-2">
          {role ? `You are signed in with the ${ROLE_LABEL[role] ?? role} role. ` : ""}This page needs a Manager or above. Ask a Manager or an Admin if you need what is on it.
        </p>
        <LinkButton href="/today" variant="primary">
          Go to Today
        </LinkButton>
      </div>
    </>
  );
}
