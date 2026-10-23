/**
 * Empty a composer TextInput.
 *
 * A `TextInput` exposes two native write paths, and each is refused in the
 * state the other one covers: `clear()` sends the event count React last saw,
 * so it is dropped once a programmatic write (`setNativeProps`, which the share
 * prefill, the Retry restore and the stop remount all use) has moved the native
 * text without that count; and `setNativeProps({ text: '' })` loses the same
 * race against a keystroke's newer count. Both requests ask for the same end
 * state — empty text, caret at 0 — so issuing both is idempotent: whichever the
 * native side accepts empties the field, and the refused one changes nothing.
 * Clearing with `clear()` alone left an auto-sent first prompt visible in the
 * session composer, where typing one character re-enabled Send over text that
 * had already been sent.
 */
export type ComposerClearableInput = {
  clear(): void;
  setNativeProps(props: { text: string; selection: { start: number; end: number } }): void;
};

export function clearComposerInput(input: ComposerClearableInput | null): void {
  if (input === null) {
    return;
  }
  input.setNativeProps({ text: '', selection: { start: 0, end: 0 } });
  input.clear();
}
