export type VoiceInputSelection = { start: number; end: number };

type VoiceInputTextInput = {
  setNativeProps(props: { text: string; selection?: VoiceInputSelection }): void;
};

type ApplyVoiceDraftOptions = {
  draft: string;
  input: VoiceInputTextInput | null;
  maxLength?: number;
  onChangeText: (draft: string) => void;
};

function resolveDraftCapping(draft: string, maxLength: number | undefined): string {
  if (maxLength === undefined) {
    return draft;
  }
  const cap = Math.max(0, Math.floor(maxLength));
  return draft.slice(0, cap);
}

/**
 * Bridges an external voice-draft string into a controlled text input and a
 * sibling onChangeText callback. The native prop is updated before the change
 * callback fires so that the input is in sync by the time listeners observe
 * the new draft. When `input` is null, only the change path is taken (the
 * composer still learns the draft). When `maxLength` is provided the draft
 * is truncated to that many characters; negative values are normalized to
 * zero so neither the native prop nor the callback receives a negative
 * slice that would strip the tail of the draft.
 */
export function applyVoiceDraftToInput({
  draft,
  input,
  maxLength,
  onChangeText,
}: ApplyVoiceDraftOptions): void {
  const next = resolveDraftCapping(draft, maxLength);
  input?.setNativeProps({ text: next });
  onChangeText(next);
}

/**
 * Recovers the speech text the controller merged into `mergedDraft`. The
 * listeners build the merged draft with `appendVoiceTranscript(baseDraft,
 * transcript)`, which appends the transcript (leading whitespace trimmed) and
 * inserts exactly one space when `baseDraft` does not already end in
 * whitespace. This is the inverse of that join: it returns the trimmed
 * transcript, or `''` when the merge could not be explained (the base draft
 * changed under the caller).
 */
export function resolveVoiceTranscriptDelta(baseDraft: string, mergedDraft: string): string {
  if (baseDraft.length === 0) {
    return mergedDraft.trimStart();
  }
  if (!mergedDraft.startsWith(baseDraft)) {
    return '';
  }
  const remainder = mergedDraft.slice(baseDraft.length);
  const lastChar = baseDraft.at(-1);
  const endsWithWhitespace =
    lastChar === ' ' || lastChar === '\n' || lastChar === '\t' || lastChar === '\r';
  if (endsWithWhitespace) {
    return remainder;
  }
  return remainder.startsWith(' ') ? remainder.slice(1) : remainder;
}

function clampSelection(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), max) : max;
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r';
}

/**
 * Splices `transcript` into `baseDraft` at the selection captured when the
 * voice session started. The selected range is replaced (an empty selection
 * inserts at the caret) and a single space is added on each side where the
 * transcript would otherwise touch a non-whitespace character, mirroring how
 * the default full-replace path joins speech. The draft never exceeds
 * `maxLength` (the transcript is truncated, never the surrounding text), and
 * the returned caret sits just after the inserted text. A null selection
 * inserts at the draft's end.
 */
export function resolveVoiceInsertion(
  baseDraft: string,
  baseSelection: VoiceInputSelection | null,
  transcript: string,
  maxLength: number | undefined
): { draft: string; selection: VoiceInputSelection } {
  const fallback = { start: baseDraft.length, end: baseDraft.length };
  const reported = baseSelection ?? fallback;
  const start = clampSelection(reported.start, baseDraft.length);
  const end = clampSelection(reported.end, baseDraft.length);
  const insertStart = Math.min(start, end);
  const insertEnd = Math.max(start, end);
  const prefix = baseDraft.slice(0, insertStart);
  const suffix = baseDraft.slice(insertEnd);
  const leading = prefix.length > 0 && !isWhitespace(prefix.at(-1)) ? ' ' : '';
  const trailing = suffix.length > 0 && !isWhitespace(suffix.at(0)) ? ' ' : '';
  const separators = leading.length + trailing.length;
  const capacity =
    maxLength === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(maxLength) - prefix.length - suffix.length);
  const room =
    capacity === Number.POSITIVE_INFINITY ? capacity : Math.max(0, capacity - separators);
  const inserted = room > 0 ? transcript.slice(0, room) : '';
  // An empty insert never pads the draft with orphan separators.
  const attachedLeading = inserted.length > 0 ? leading : '';
  const attachedTrailing = inserted.length > 0 ? trailing : '';
  const caretOffset = prefix.length + attachedLeading.length + inserted.length;
  return {
    draft: prefix + attachedLeading + inserted + attachedTrailing + suffix,
    selection: { start: caretOffset, end: caretOffset },
  };
}

export type ApplyVoiceDraftAtSelectionOptions = {
  /** Draft captured when the voice session started (the controller's base). */
  baseDraft: string;
  /** Caret (or replaced range) captured when the voice session started. */
  baseSelection: VoiceInputSelection | null;
  /** The live text currently in the input. */
  currentDraft: string;
  /** The last draft this helper produced; `baseDraft` on the first result. */
  expectedDraft: string;
  /** Full merged draft the controller produced for this result. */
  mergedDraft: string;
  /** True while an IME composition is active; inserts are skipped. */
  isComposing: boolean;
  input: VoiceInputTextInput | null;
  maxLength?: number;
  onChangeText: (draft: string) => void;
};

export type ApplyVoiceDraftAtSelectionResult =
  | { kind: 'inserted'; draft: string; selection: VoiceInputSelection }
  | { kind: 'aborted' };

/**
 * Selection-aware dictation path used by the agent composers: interim and
 * final speech splice into the caret captured at session start instead of
 * replacing the whole draft. If an IME composition is active, or the live
 * draft no longer matches the draft this helper last produced (the user
 * edited the speech range), the input is left untouched and `aborted` is
 * returned so the caller can stop recognition and keep the user's text.
 */
export function applyVoiceDraftAtSelection({
  baseDraft,
  baseSelection,
  currentDraft,
  expectedDraft,
  mergedDraft,
  isComposing,
  input,
  maxLength,
  onChangeText,
}: ApplyVoiceDraftAtSelectionOptions): ApplyVoiceDraftAtSelectionResult {
  if (isComposing) {
    return { kind: 'aborted' };
  }
  if (currentDraft !== expectedDraft) {
    return { kind: 'aborted' };
  }
  const transcript = resolveVoiceTranscriptDelta(baseDraft, mergedDraft);
  const next = resolveVoiceInsertion(baseDraft, baseSelection, transcript, maxLength);
  input?.setNativeProps({ text: next.draft, selection: next.selection });
  onChangeText(next.draft);
  return { kind: 'inserted', draft: next.draft, selection: next.selection };
}
