type ComposerSelection = { start: number; end: number };

type InsertPastedTextOptions = {
  draft: string;
  /** The composer's last known caret, or null when nothing reported one yet. */
  selection: ComposerSelection | null;
  text: string;
  maxLength: number;
};

type InsertPastedTextResult = { draft: string; caret: number };

/** Clamp a reported offset into `[0, max]`. */
function clampOffset(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), max);
}

/**
 * Insert clipboard text into a draft the way the platform paste does: the text
 * replaces the selected range and the caret lands after the inserted text.
 *
 * A null or out-of-range `selection` clamps to the draft's end, so a caret the
 * composer has not heard about pastes at the end instead of inside a word. The
 * result never exceeds `maxLength`; the pasted text is truncated, never the
 * text the user already typed.
 */
export function insertPastedText({
  draft,
  selection,
  text,
  maxLength,
}: InsertPastedTextOptions): InsertPastedTextResult {
  const cap = Math.max(0, Math.floor(maxLength));
  const end = clampOffset(selection?.end ?? draft.length, draft.length);
  const start = Math.min(clampOffset(selection?.start ?? draft.length, draft.length), end);
  const prefix = draft.slice(0, start);
  const suffix = draft.slice(end);
  const room = cap - prefix.length - suffix.length;
  const inserted = room > 0 ? text.slice(0, room) : '';
  return { draft: prefix + inserted + suffix, caret: prefix.length + inserted.length };
}
