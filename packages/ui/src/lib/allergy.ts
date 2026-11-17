/**
 * Whether a kitchen note speaks of an allergy or intolerance ("Nut allergy", "no gluten, coeliac", "Allergie: Sesam").
 * Such a note gets the same quiet emphasis wherever staff decide on it: the order panel, the Now card and the kitchen
 * ticket (final review C-11). A miss only loses the emphasis; the note itself is always shown in full.
 */
const ALLERGY = /(allerg|allergi|anaphyla|epipen|intoleran|coeliac|celiac|z[öo]liakie|\bnuts?\b|\bpeanuts?\b|\btree ?nuts?\b|n[üu]sse|erdn[üu]ss|gluten|lactose|laktose|dairy|shellfish|crustacean|sesame|sesam\b)/i;

export function mentionsAllergy(note: string | null | undefined): boolean {
  return !!note && ALLERGY.test(note);
}

/** The emphasis: the note upright, semibold and in the alert colour, in place of a note's usual italic colour and weight. */
export const ALLERGY_NOTE_CLASS = "font-semibold text-status-alert";
