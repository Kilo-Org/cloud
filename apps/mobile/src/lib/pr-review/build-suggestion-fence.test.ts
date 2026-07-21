import { describe, expect, it } from 'vitest';

import { buildSuggestionFence } from '@/lib/pr-review/build-suggestion-fence';

describe('buildSuggestionFence', () => {
  it('returns null for an empty selection', () => {
    expect(buildSuggestionFence('')).toBeNull();
  });

  it('wraps a single line verbatim', () => {
    expect(buildSuggestionFence('    const x = 1;')).toBe('```suggestion\n    const x = 1;\n```');
  });

  it('preserves multi-line indentation and spacing exactly', () => {
    const selectedText = ['function add(a, b) {', '    return a + b;', '}'].join('\n');
    expect(buildSuggestionFence(selectedText)).toBe(
      ['```suggestion', 'function add(a, b) {', '    return a + b;', '}', '```'].join('\n')
    );
  });

  it('preserves leading and trailing blank lines', () => {
    const selectedText = '\n  indented\n';
    expect(buildSuggestionFence(selectedText)).toBe('```suggestion\n\n  indented\n\n```');
  });
});
