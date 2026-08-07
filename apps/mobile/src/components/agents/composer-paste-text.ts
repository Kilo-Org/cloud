export type ComposerSelection = { start: number; end: number };

type ComposerPasteTarget = {
  /** The uncontrolled TextInput, or null before it mounts. */
  input: {
    setNativeProps(props: { text: string; selection: ComposerSelection }): void;
  } | null;
  /** The composer's live draft. */
  draft: string;
  /** The last caret the input reported, or null when it reported none yet. */
  selection: ComposerSelection | null;
  maxLength: number;
  onChangeText: (text: string) => void;
};

/** Order a reported selection and clamp both bounds into `[0, max]`. */
function clampSelection(selection: ComposerSelection, max: number): ComposerSelection {
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), max) : max;
  const start = clamp(selection.start);
  const end = clamp(selection.end);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * Paste `text` into a composer the way the platform paste does: the text
 * replaces the selected range, the caret lands after it, and the draft never
 * exceeds `maxLength` — the pasted text is truncated, never the text the user
 * already typed. A null selection, or one the input never reported, pastes at
 * the draft's end.
 *
 * Returns the new caret so the caller can update its selection ref: RN fires
 * no selection event for a `setNativeProps` write.
 */
export function pasteTextIntoComposer(
  text: string,
  target: ComposerPasteTarget
): ComposerSelection {
  const { start, end } = clampSelection(
    target.selection ?? { start: target.draft.length, end: target.draft.length },
    target.draft.length
  );
  const prefix = target.draft.slice(0, start);
  const suffix = target.draft.slice(end);
  const room = Math.max(0, Math.floor(target.maxLength)) - prefix.length - suffix.length;
  const inserted = room > 0 ? text.slice(0, room) : '';
  const caretOffset = prefix.length + inserted.length;
  const caret = { start: caretOffset, end: caretOffset };
  const draft = prefix + inserted + suffix;

  target.input?.setNativeProps({ text: draft, selection: caret });
  // RN fires no change event for setNativeProps, so tell the composer itself.
  target.onChangeText(draft);
  return caret;
}
