import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { LocaleProvider } from "../lib/locale";
import { DataTable } from "./DataTable";

const inLocale = (node: ReactNode) => <LocaleProvider settings={{ currency: "SGD", currencyExponent: 2, locale: "en-SG", timeZone: "Asia/Singapore" }}>{node}</LocaleProvider>;

const columns = [{ key: "name", header: "Name", isRowHeader: true, render: (r: { id: string; name: string }) => r.name }];
const rows = [{ id: "a", name: "Ada" }];

describe("DataTable before hydration", () => {
  it("server-rendered rows that open something say they are not interactive yet", () => {
    const html = renderToStaticMarkup(inLocale(<DataTable aria-label="Staff" columns={columns} rows={rows} rowKey={(r) => r.id} onRowAction={() => {}} />));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Ada");
  });

  it("a table with no row action is not marked", () => {
    const html = renderToStaticMarkup(inLocale(<DataTable aria-label="Staff" columns={columns} rows={rows} rowKey={(r) => r.id} />));
    expect(html).not.toContain("aria-disabled");
  });
});
