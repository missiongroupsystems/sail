"use client";

import { Icon, SectionHeading } from "@sail/ui";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Check, Circle } from "lucide-react";
import Link from "next/link";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import { useSession } from "@/lib/session-context";

type Step = { id: string; title: string; hint: string; href: string; action: string; done: boolean };

/**
 * The steps between first-run setup and a first order, each ticked from what the register already holds: products on
 * a menu in a section, the menu linked to the POS, tables, the Admin's own POS PIN, a paired iPad, and a destination
 * on any kitchen display, and a first shift, since cash is refused until one is open. Shown to an Admin on Today until every step is done, then gone.
 */
export function SetupChecklist({ outletId, tableCount }: { outletId: string; tableCount: number | null }) {
  const { me } = useSession();
  const enabled = me.role === "admin";
  const products = useQuery({ queryKey: ["setup", "products"], queryFn: () => req(api.GET("/v1/products", { params: { query: { kind: "product", limit: 1 } } })).then((r) => r.data), enabled });
  const menus = useQuery({ queryKey: ["setup", "menus"], queryFn: () => req(api.GET("/v1/menus")).then((r) => r.data.filter((m) => !m.archived)), enabled });
  const menuDetails = useQueries({
    queries: (menus.data ?? []).slice(0, 10).map((m) => ({ queryKey: ["setup", "menu", m.id], queryFn: () => req(api.GET("/v1/menus/{id}", { params: { path: { id: m.id } } })).then((r) => r.data), enabled })),
  });
  const links = useQuery({ queryKey: ["setup", "links", outletId], queryFn: () => req(api.GET("/v1/channel-links", { params: { query: { outlet_id: outletId, channel: "pos" } } })).then((r) => r.data), enabled });
  const staff = useQuery({ queryKey: ["setup", "staff"], queryFn: () => req(api.GET("/v1/staff")).then((r) => r.data), enabled });
  const shifts = useQuery({ queryKey: ["setup", "shifts", outletId], queryFn: () => req(api.GET("/v1/outlets/{id}/shifts", { params: { path: { id: outletId } } })).then((r) => r.data), enabled });
  const stations = useQuery({ queryKey: ["setup", "stations", outletId], queryFn: () => req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId } } })).then((r) => r.data.filter((s) => !s.archived)), enabled });

  const loading = [products, menus, links, staff, stations, shifts].some((q) => q.isPending) || menuDetails.some((q) => q.isPending) || tableCount === null;
  if (!enabled || loading) return null;

  const onMenu = menuDetails.some((q) => q.data?.sections.some((s) => s.items.length > 0));
  const displays = (stations.data ?? []).filter((s) => s.kind === "display");
  const steps: Step[] = [
    { id: "products", title: "Add the products you sell", hint: "Options such as sides and extras are products too, of kind Component.", href: "/menu/products", action: "Products", done: (products.data ?? []).length > 0 },
    { id: "menu", title: "Put them on a menu, in a section", hint: "The POS and the guest app only show products that sit in a menu section. Save with Save menu order.", href: "/menu/menus", action: "Menus & sections", done: onMenu },
    { id: "link", title: "Link the menu to the POS", hint: "A channel link says which menu this outlet's POS sells.", href: "/settings/channels", action: "Channels", done: (links.data ?? []).some((l) => l.enabled) },
    { id: "tables", title: "Add your tables", hint: "Dine-in orders start from a table on the floor plan.", href: "/floor", action: "Floor & QR", done: (tableCount ?? 0) > 0 },
    { id: "pin", title: "Set your own POS PIN", hint: "You sign in on the iPad with a PIN, not your password.", href: "/team", action: "Team", done: Boolean(staff.data?.find((s) => s.id === me.id)?.has_pin) },
    { id: "pair", title: "Pair an iPad as a POS", hint: "On the station, choose Pair an iPad, then open /pos on the iPad and enter the code.", href: "/settings/stations", action: "Stations", done: (stations.data ?? []).some((s) => s.kind === "pos" && s.paired) },
    { id: "shift", title: "Open a shift before taking cash", hint: "Cash goes into a drawer that is counted when the shift closes, so the register refuses cash until a shift is open. On the POS, go to Shift and open one with its float. Card payments need no shift.", href: "/pos", action: "POS", done: (shifts.data ?? []).length > 0 },
    ...(displays.length
      ? [{ id: "kds", title: "Choose what each kitchen display shows", hint: "A kitchen display shows nothing until a display destination is ticked on its station.", href: "/settings/stations", action: "Stations", done: displays.every((s) => s.display_destination_ids.length > 0) }]
      : []),
  ];
  const left = steps.filter((s) => !s.done).length;
  if (left === 0) return null;

  return (
    <section aria-labelledby="setup-checklist" className="mb-10">
      <div id="setup-checklist">
        <SectionHeading title="Get ready for the first order" aside={`${steps.length - left} of ${steps.length} done`} />
      </div>
      <ol className="flex flex-col">
        {steps.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 hairline-b">
            <Icon icon={s.done ? Check : Circle} size={18} className={s.done ? "text-status-paid" : "text-ink-2"} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className={s.done ? "block text-body text-ink-2" : "block text-body text-ink"}>
                {s.title}
                <span className="sr-only">{s.done ? ", done" : ", to do"}</span>
              </span>
              {s.done ? null : <span className="block text-caption text-ink-2">{s.hint}</span>}
            </span>
            {s.done ? null : (
              <Link href={s.href} className="text-body text-ink underline underline-offset-4">
                {s.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
