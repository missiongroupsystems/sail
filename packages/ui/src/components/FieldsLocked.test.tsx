import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FieldsLocked } from "./FieldsLocked";
import { TextField } from "./TextField";
import { Select } from "./Select";
import { Switch } from "./Switch";
import { Checkbox } from "./Checkbox";
import { DateField } from "./DateField";
import { TagsField } from "../backoffice/TagsField";
import { MoneyField } from "../backoffice/MoneyField";
import { PercentField } from "../backoffice/PercentField";
import { LocaleProvider } from "../lib/locale";

const settings = { currency: "SGD", currencyExponent: 2, locale: "en-SG", timeZone: "Asia/Singapore" };
const fields = () => (
  <LocaleProvider settings={settings}>
    <TextField label="Name" defaultValue="Kopi" />
    <Select label="Shape" items={[{ id: "a", label: "Round" }]} selectedKey="a" onSelectionChange={() => {}} />
    <Switch>Offer tips</Switch>
    <Checkbox>Kitchen</Checkbox>
    <DateField aria-label="From" value="2026-11-14" onChange={() => {}} />
    <TagsField label="Notes and coins" value={["$5.00"]} onChange={() => {}} />
    <MoneyField label="Price" value={500} onChange={() => {}} />
    <PercentField label="Rate" value={900} onChange={() => {}} />
  </LocaleProvider>
);

describe("FieldsLocked (L3)", () => {
  it("turns off every field and every chip's Remove inside it, so a read-only role sees nothing it could type into", () => {
    const html = renderToStaticMarkup(<FieldsLocked locked>{fields()}</FieldsLocked>);
    const controls = html.match(/<(input|textarea|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(9);
    for (const c of controls) expect(c, c).toMatch(/\sdisabled=""/);
    expect(html).not.toContain('aria-label="Clear From"');
  });

  it("leaves the fields alone when not locked, or outside it", () => {
    for (const html of [renderToStaticMarkup(<FieldsLocked locked={false}>{fields()}</FieldsLocked>), renderToStaticMarkup(fields())]) {
      expect(html).toMatch(/<input\b[^>]*value="Kopi"[^>]*>/);
      expect(html.match(/<input\b[^>]*value="Kopi"[^>]*>/)![0]).not.toMatch(/\sdisabled=""/);
      expect(html).toMatch(/aria-label="Remove \$5\.00"/);
      expect(html.match(/<button\b[^>]*aria-label="Remove \$5\.00"[^>]*>/)![0]).not.toMatch(/\sdisabled=""/);
    }
  });
});
