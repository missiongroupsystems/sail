/**
 * A page with changes not yet saved registers its question here, so Sign out asks it before it ends the session. Once
 * the person agrees, the page's own "leave site?" guard stands aside for the reload to sign-in.
 */
let question: string | null = null;
let leaving = false;

export const unsavedChanges = {
  set(q: string | null) {
    question = q;
  },
  /** True when there is nothing unsaved or the person agrees to lose it. */
  confirmLeave(): boolean {
    if (!question) return true;
    if (!window.confirm(question)) return false;
    leaving = true;
    return true;
  },
  get leaving() {
    return leaving;
  },
};
