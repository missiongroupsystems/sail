"use client";

import { Button, TextField } from "@sail/ui";
import { GREY_PILL } from "./styles";

export const QUICK_NOTES = ["No ice", "Less sugar", "Less spicy", "Extra spicy", "No chilli", "No onion", "Takeaway pack", "Allergy: see note"];

/** Between the parts of a line's note, as saved and as every screen shows it: "Allergy: see note · Peanut allergy". */
export const NOTE_SEPARATOR = " · ";
const NOTE_MAX = 200;

/** A line's note in its two parts: the quick notes tapped (in tap order) and what was typed. */
export type NoteParts = { chips: string[]; text: string };
export const NO_NOTE: NoteParts = { chips: [], text: "" };

/** The saved note: the quick notes, then the typed text, each part once, joined with the separator; null when empty. */
export function joinNote({ chips, text }: NoteParts): string | null {
  const parts = [...chips, text.trim()].filter(Boolean);
  return parts.length ? parts.join(NOTE_SEPARATOR).slice(0, NOTE_MAX) : null;
}

/**
 * A saved note back into its parts, so its quick notes show as chosen when the line is edited. A part that is a quick
 * note is a chip; so is one written before the separator existed ("No ice, Less sugar"). Everything else is the text.
 */
export function splitNote(note: string | null | undefined): NoteParts {
  if (!note) return NO_NOTE;
  const chips: string[] = [];
  const text: string[] = [];
  for (const part of note.split(NOTE_SEPARATOR)) {
    const legacy = part.split(", ");
    if (QUICK_NOTES.includes(part)) chips.push(part);
    else if (legacy.length > 1 && legacy.every((p) => QUICK_NOTES.includes(p))) chips.push(...legacy);
    else if (part.trim()) text.push(part);
  }
  return { chips: [...new Set(chips)], text: text.join(NOTE_SEPARATOR) };
}

/**
 * Quick notes and the typed note, kept apart (review 4 U3): a chip is on while its text is part of the note, typing
 * never runs into it, and the two are joined with the separator only when saved.
 */
export function QuickNotes({ value, onChange }: { value: NoteParts; onChange: (next: NoteParts) => void }) {
  const toggle = (chip: string) => onChange({ ...value, chips: value.chips.includes(chip) ? value.chips.filter((c) => c !== chip) : [...value.chips, chip] });
  // What the chips take of the note's 200 characters, so the typed part never pushes one out.
  const room = Math.max(0, NOTE_MAX - value.chips.reduce((n, c) => n + c.length + NOTE_SEPARATOR.length, 0));
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        {QUICK_NOTES.map((c) => {
          const on = value.chips.includes(c);
          return (
            <Button key={c} size="md" variant={on ? "primary" : "quiet"} aria-pressed={on} onPress={() => toggle(c)} className={(on ? "" : GREY_PILL + " ") + "text-[14.5px] font-normal"}>
              {c}
            </Button>
          );
        })}
      </div>
      <TextField aria-label="Note" value={value.text} onChange={(text) => onChange({ ...value, text })} placeholder="Note for the kitchen" inputClassName="min-h-14 text-line" maxLength={room} />
    </>
  );
}
