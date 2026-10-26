import { describe, expect, it } from '@jest/globals';

import { escapeSlackLabel, escapeSlackText } from './slack-escape';

describe('escapeSlackText', () => {
  it('keeps mention and link tokens as literal text', () => {
    expect(escapeSlackText('<!channel> ping <@U12345>')).toBe(
      '&lt;!channel&gt; ping &lt;@U12345&gt;'
    );
    expect(escapeSlackText('see <https://example.com/a|the docs>')).toBe(
      'see &lt;https://example.com/a|the docs&gt;'
    );
  });

  it('escapes the entity delimiter before the angle brackets', () => {
    expect(escapeSlackText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeSlackText('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeSlackText('plain feedback about the send button')).toBe(
      'plain feedback about the send button'
    );
  });
});

describe('escapeSlackLabel', () => {
  it('replaces backticks so the value stays inside a code span', () => {
    expect(escapeSlackLabel('a ` b')).toBe("a ' b");
  });

  it('collapses line breaks so a value stays on one line', () => {
    expect(escapeSlackLabel('line one\nline two\r\nline three\rline four')).toBe(
      'line one line two line three line four'
    );
  });

  it('escapes markup inside the label', () => {
    expect(escapeSlackLabel('<https://example.com|label>`')).toBe(
      "&lt;https://example.com|label&gt;'"
    );
  });
});
