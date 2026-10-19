/**
 * The pasted PR-review link, retained so a back-remount of the entry screen
 * (the connect gate's loading state, a cancelled open) restores the field
 * without a re-paste. Memory-only, like the login email draft: the remount
 * happens within one app run, and a persisted link would outlive sign-out.
 */

let fieldDraft = '';

/** Record the field text so the next entry-screen mount can restore it. */
export function setPrLinkFieldDraft(text: string): void {
  fieldDraft = text;
}

/**
 * Read the draft and drop it. Single-shot: a later, unrelated mount must not
 * resurrect a link the user already cleared or opened elsewhere.
 */
export function popPrLinkFieldDraft(): string {
  const draft = fieldDraft;
  fieldDraft = '';
  return draft;
}

/** Drop the draft without returning it. Sign-out and test isolation use this. */
export function clearPrLinkFieldDraft(): void {
  fieldDraft = '';
}
