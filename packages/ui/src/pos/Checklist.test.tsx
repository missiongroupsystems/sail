import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checklist, checklistDone, checklistStatus, type ChecklistItem } from "./Checklist";

const item = (status: ChecklistItem["status"]): ChecklistItem => ({ id: status, title: `${status} item`, status, onView: () => undefined, onLeave: () => undefined });

describe("close-shift checklist status (an item is only resolved once its register read has answered)", () => {
  it("is checking while the read has not answered, whatever was left", () => {
    expect(checklistStatus({ count: null, failed: false }, false)).toBe("checking");
    expect(checklistStatus({ count: null, failed: false }, true)).toBe("checking");
  });
  it("is resolved once the read answers with nothing", () => {
    expect(checklistStatus({ count: 0, failed: false }, false)).toBe("resolved");
  });
  it("is open once the read answers with something, and left once the person leaves it", () => {
    expect(checklistStatus({ count: 2, failed: false }, false)).toBe("open");
    expect(checklistStatus({ count: 2, failed: false }, true)).toBe("left");
  });
  it("is open, never resolved, when the read failed, and can be left", () => {
    expect(checklistStatus({ count: null, failed: true }, false)).toBe("open");
    expect(checklistStatus({ count: null, failed: true }, true)).toBe("left");
  });
  it("is done only when every item is resolved or left", () => {
    expect(checklistDone([item("resolved"), item("left")])).toBe(true);
    expect(checklistDone([item("resolved"), item("checking")])).toBe(false);
    expect(checklistDone([item("resolved"), item("open")])).toBe(false);
  });
  it("offers no View or Leave open on an item still checking", () => {
    const html = renderToStaticMarkup(<Checklist items={[item("checking")]} />);
    expect(html).toContain("checking item");
    expect(html).not.toContain("Leave open");
    expect(html).not.toContain("View");
    expect(renderToStaticMarkup(<Checklist items={[item("open")]} />)).toContain("Leave open");
  });
});
