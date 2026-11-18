/**
 * A report page as CSV: the same rows and totals the page shows, read from the page itself, so the file can never
 * disagree with the screen. Amounts come from `<Money>` (`data-cents`, the register's minor units) and are written as
 * plain decimals; business dates come from `<BusinessDay>` (`<time dateTime>`) and are written as ISO dates.
 * Nothing here adds, subtracts or rounds: a minor-unit integer is only moved past its decimal point.
 */

/** One CSV line's cells. */
export type CsvRow = string[];

/** Minor units as a plain decimal in the currency's exponent: 1234 at 2 → "12.34", -5 at 2 → "-0.05", 500 at 0 → "500". */
export function minorToDecimal(minor: number, exponent: number): string {
  if (!Number.isInteger(minor)) throw new Error(`not minor units: ${minor}`);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor));
  if (exponent <= 0) return sign + digits;
  const padded = digits.padStart(exponent + 1, "0");
  return `${sign}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

/** One cell, quoted when it holds a comma, quote or line break; a leading formula character is neutralised. */
export function csvCell(value: string): string {
  const safe = /^[=+@\t\r]/.test(value) || (/^-/.test(value) && !/^-\d+(\.\d+)?$/.test(value)) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows as CSV text with CRLF line ends (RFC 4180), which every spreadsheet opens. */
export function toCsv(rows: CsvRow[]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const SKIP = "[data-export='skip'],[aria-hidden='true'],button,[role='button'],svg";

/** A figure cell: the "—" a page shows for "none" is an empty cell, so a spreadsheet's number column stays numbers. */
const figure = (s: string) => (s === "—" ? "" : s);

/**
 * A value that pairs a count with an amount ("1 · 2.99", voids) is two cells, count then amount; every other value is
 * one cell (review 2, N11: "0 · 0.00" sat in one cell).
 */
function valueCells(dd: Element, exponent: number): string[] {
  const text = figure(cellText(dd, exponent));
  const m = /^(-?\d+) · (-?\d+(?:\.\d+)?)$/.exec(text);
  return m && dd.querySelectorAll("[data-cents]").length === 1 ? [m[1]!, m[2]!] : [text];
}

/** An element's text with each amount as a decimal and each business date as YYYY-MM-DD, whitespace collapsed. */
export function cellText(el: Element, exponent: number): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const e = node as Element;
    if (e.matches(SKIP)) return;
    const cents = e.getAttribute("data-cents");
    if (cents !== null && /^-?\d+$/.test(cents)) {
      parts.push(minorToDecimal(Number(cents), exponent));
      return;
    }
    if (e.tagName === "TIME" && e.getAttribute("datetime")) {
      parts.push(e.getAttribute("datetime")!);
      return;
    }
    e.childNodes.forEach(walk);
  };
  walk(el);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * The report under `root` as CSV rows, in reading order: a panel title starts a block (after a blank line), label/value
 * rows (`<dl>`) are "label, value", a table is its header row then its body rows, and a list item with an amount is
 * "text, amount". Notes, buttons and empty-state lines are left out.
 */
export function reportRows(root: Element, exponent: number): CsvRow[] {
  const rows: CsvRow[] = [];
  const block = (title: string | null) => {
    if (rows.length) rows.push([]);
    if (title) rows.push([title]);
  };
  const visit = (el: Element) => {
    if (el.matches(SKIP)) return;
    if (el.tagName === "SECTION") {
      const heading = el.querySelector(":scope > div > h2, :scope > div > h3, :scope > h2, :scope > h3");
      block(heading ? cellText(heading, exponent) : null);
      for (const child of Array.from(el.children)) if (!child.contains(heading)) visit(child);
      return;
    }
    if (el.tagName === "DL") {
      for (const item of Array.from(el.children)) {
        const dt = item.querySelector("dt");
        const dd = item.querySelector("dd");
        if (dt && dd) rows.push([cellText(dt, exponent), ...valueCells(dd, exponent)]);
      }
      return;
    }
    if (el.tagName === "TABLE") {
      // A column whose cell shows two things on two lines (a time and who did it) names its CSV columns in
      // `data-export-columns` ("Closed|Closed by") and marks each part of the cell `data-export-part`, so a spreadsheet
      // gets one value per column (review 5, V5).
      const ths = Array.from(el.querySelectorAll("thead th"));
      const split = ths.map((th) => th.querySelector("[data-export-columns]")?.getAttribute("data-export-columns")?.split("|") ?? null);
      const header = ths.flatMap((th, i) => split[i] ?? [cellText(th, exponent)]);
      if (header.length) rows.push(header);
      for (const tr of Array.from(el.querySelectorAll("tbody tr"))) {
        const cells = Array.from(tr.querySelectorAll(":scope > th, :scope > td"));
        // An empty table's one wide cell is its empty-state line, not a row.
        if (cells.length !== ths.length) continue;
        rows.push(
          cells.flatMap((c, i) => {
            const names = split[i];
            if (!names) return [figure(cellText(c, exponent))];
            const parts = Array.from(c.querySelectorAll("[data-export-part]")).map((x) => figure(cellText(x, exponent)));
            const values = parts.length ? parts : [figure(cellText(c, exponent))];
            return names.map((_, k) => values[k] ?? "");
          }),
        );
      }
      return;
    }
    if (el.tagName === "LI") {
      const amounts = Array.from(el.querySelectorAll("[data-cents]"));
      const last = amounts[amounts.length - 1];
      if (last) {
        const label = el.cloneNode(true) as Element;
        const amountsInLabel = label.querySelectorAll("[data-cents]");
        amountsInLabel[amountsInLabel.length - 1]!.remove();
        rows.push([cellText(label, exponent), cellText(last, exponent)]);
      }
      return;
    }
    // Notes are left out, except one the page marks as part of the figures (the Z-report's open-shift line).
    if (el.tagName === "P") {
      if (el.getAttribute("data-export") === "note") rows.push([cellText(el, exponent)]);
      return;
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(root);
  return rows;
}
