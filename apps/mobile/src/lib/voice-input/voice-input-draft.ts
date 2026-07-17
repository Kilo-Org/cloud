type VoiceInputTextInput = {
  setNativeProps(props: { text: string }): void;
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
