import { describe, expect, it } from '@jest/globals';

import {
  SLACK_TRUNCATION_MARKER,
  escapeSlackLabel,
  escapeSlackText,
  truncateSlackText,
} from './slack-escape';

describe('escapeSlackText', () => {
  it('neutralizes mention and link tokens', () => {
    expect(escapeSlackText('<!channel> ping <@U12345>')).toBe(
      '&lt;!channel&gt; ping &lt;@U12345&gt;'
    );
    expect(escapeSlackText('see <https://example.com/phish|the docs>')).toBe(
      'see &lt;https://example.com/phish|the docs&gt;'
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
  it('neutralizes backticks so the value cannot close a code span', () => {
    expect(escapeSlackLabel('a ` b')).toBe("a ' b");
  });

  it('collapses line breaks so a value cannot forge a message line', () => {
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

describe('truncateSlackText', () => {
  it('returns the value unchanged at or under the limit', () => {
    expect(truncateSlackText('short', 5)).toBe('short');
    expect(truncateSlackText('exact', 5)).toBe('exact');
  });

  it('caps the result and marks that content was dropped', () => {
    const result = truncateSlackText('abcdefghij'.repeat(5), 20);
    expect(result).toBe(`abcdefg${SLACK_TRUNCATION_MARKER}`);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('does not split a surrogate pair at the cut', () => {
    const value = `aa${'😀'.repeat(8)}`;
    expect(truncateSlackText(value, 16)).toBe(`aa${SLACK_TRUNCATION_MARKER}`);
  });

  it('returns only the marker when the limit is smaller than the marker', () => {
    const result = truncateSlackText('abcdefghij', 4);
    expect(result).toBe(SLACK_TRUNCATION_MARKER.slice(0, 4));
  });
});
