// The name box's preview decision, extracted from NameField in the list
// settings sheet so the caret contract stays testable without the component
// import chain. An unfocused single-line Android field keeps its caret
// wherever it last was and draws the tail of a long saved name — a
// programmatic start selection does not scroll it (verified on the emulator)
// — so the unfocused state renders a one-line Text preview that clips the
// END and shows the beginning of the name.

export type NameFieldPreviewInput = {
  /** The user is editing in the real input right now. */
  editing: boolean;
  /** The saved name is non-empty. */
  hasText: boolean;
};

/**
 * Whether to render the one-line start-visible preview instead of the real
 * input: only while not editing and a saved name exists. An empty name keeps
 * the input mounted so its placeholder shows.
 */
export function showNamePreview({ editing, hasText }: NameFieldPreviewInput): boolean {
  return !editing && hasText;
}
