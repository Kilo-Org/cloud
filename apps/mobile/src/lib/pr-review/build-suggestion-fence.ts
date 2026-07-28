// Pure helper for the PR review comment composer: builds a
// ```suggestion fenced block from the selected right-side text.
//
// The fence content must match the displayed lines EXACTLY — no
// added or removed indentation — otherwise GitHub will apply the
// wrong replacement.

export function buildSuggestionFence(selectedText: string): string | null {
  if (selectedText.length === 0) {
    return null;
  }
  const lines = selectedText.split('\n');
  return ['```suggestion', ...lines, '```'].join('\n');
}
