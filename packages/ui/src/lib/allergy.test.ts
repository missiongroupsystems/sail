import { describe, expect, it } from "vitest";
import { mentionsAllergy } from "./allergy";

describe("mentionsAllergy", () => {
  it("finds an allergy or intolerance in a kitchen note", () => {
    for (const n of ["Nut allergy", "No nuts please", "severe peanut allergy, carries an EpiPen", "coeliac", "gluten free", "Allergie: Sesam", "lactose intolerant", "shellfish"]) expect(mentionsAllergy(n), n).toBe(true);
  });
  it("leaves ordinary notes alone", () => {
    for (const n of ["Less spicy", "No ice", "Doughnut on the side", "Extra sauce", "", null, undefined]) expect(mentionsAllergy(n), String(n)).toBe(false);
  });
});
