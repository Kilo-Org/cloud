import { describe, expect, it } from 'vitest';

import { rtlListItems } from './markdown-rtl-list-items';

// RIGHT-TO-LEFT MARK, FIRST-STRONG ISOLATE and POP DIRECTIONAL ISOLATE are
// written out in every expectation, so the vectors state the exact bytes.
describe('rtlListItems', () => {
  it('names the start edge after a bullet marker', () => {
    expect(rtlListItems('- The layout holds.')).toBe('- \u200F\u2068The layout holds.\u2069');
  });

  it('names it after an ordered marker', () => {
    expect(rtlListItems('1. First\n2) Second')).toBe(
      '1. \u200F\u2068First\u2069\n2) \u200F\u2068Second\u2069'
    );
  });

  it('opens the isolate after a task checkbox', () => {
    expect(rtlListItems('- [ ] Check the layout\n- [x] Ship it')).toBe(
      '- [ ] \u200F\u2068Check the layout\u2069\n- [x] \u200F\u2068Ship it\u2069'
    );
  });

  it('wraps a nested item and a blockquote item separately', () => {
    expect(rtlListItems('  - Nested')).toBe('  - \u200F\u2068Nested\u2069');
    expect(rtlListItems('> - Quoted\n> - Second')).toBe(
      '> - \u200F\u2068Quoted\u2069\n> - \u200F\u2068Second\u2069'
    );
  });

  it('keeps one isolate open across a lazy continuation line', () => {
    expect(rtlListItems('- The list ranks first.\n  A wrapped line ends here.')).toBe(
      '- \u200F\u2068The list ranks first.\n  A wrapped line ends here.\u2069'
    );
  });

  it('closes the isolate at the end of the item before a paragraph', () => {
    expect(rtlListItems('- The list ranks first.\n\nThe paragraph follows.')).toBe(
      '- \u200F\u2068The list ranks first.\u2069\n\nThe paragraph follows.'
    );
  });

  it('closes the isolate at the end of the item before a fence', () => {
    expect(rtlListItems('- item\n```md\n- item\n```')).toBe(
      '- \u200F\u2068item\u2069\n```md\n- item\n```'
    );
  });

  it('leaves a marker with no content alone', () => {
    expect(rtlListItems('- \n-')).toBe('- \n-');
  });

  it('names the start edge in a deeply indented item', () => {
    expect(rtlListItems('- one\n  - two\n    - three')).toBe(
      '- \u200F\u2068one\u2069\n  - \u200F\u2068two\u2069\n    - \u200F\u2068three\u2069'
    );
  });

  it('keeps a list-shaped line inside a fence exactly', () => {
    expect(rtlListItems('```md\n- item\n```\n- item')).toBe(
      '```md\n- item\n```\n- \u200F\u2068item\u2069'
    );
  });

  it('keeps a fence open until a run of the same mark closes it', () => {
    expect(rtlListItems('~~~\n- item\n~~~\n- item')).toBe(
      '~~~\n- item\n~~~\n- \u200F\u2068item\u2069'
    );
  });

  it('does not close a fence on a line carrying an info string', () => {
    expect(rtlListItems('```md\n```js\n- item\n```\n- item')).toBe(
      '```md\n```js\n- item\n```\n- \u200F\u2068item\u2069'
    );
  });

  it('tracks a fence inside a blockquote', () => {
    expect(rtlListItems('> ```md\n> - item\n> ```\n- item')).toBe(
      '> ```md\n> - item\n> ```\n- \u200F\u2068item\u2069'
    );
  });

  it('keeps a fence open when a fence run in its body is indented too deep to close', () => {
    expect(rtlListItems('```\n    ```\n    - still code\n```\n- item')).toBe(
      '```\n    ```\n    - still code\n```\n- \u200F\u2068item\u2069'
    );
  });

  it('keeps an indented code block exactly', () => {
    expect(rtlListItems('Example:\n\n    - item\n\n- item')).toBe(
      'Example:\n\n    - item\n\n- \u200F\u2068item\u2069'
    );
  });

  it('keeps every line of a tab-indented code block exactly', () => {
    const value = 'Example:\n\n\t- first\n\t- second\n';
    expect(rtlListItems(value)).toBe(value);
  });

  it('leaves a thematic break alone', () => {
    expect(rtlListItems('- - -')).toBe('- - -');
    expect(rtlListItems('* * *')).toBe('* * *');
    expect(rtlListItems('---')).toBe('---');
    expect(rtlListItems('_ _ _')).toBe('_ _ _');
  });

  it('leaves a blockquoted thematic break alone', () => {
    expect(rtlListItems('> - - -')).toBe('> - - -');
    expect(rtlListItems('> * * *')).toBe('> * * *');
  });

  it('returns markdown without a list unchanged', () => {
    const value = 'A reply with no list.\n\n> quoted\n';
    expect(rtlListItems(value)).toBe(value);
  });
});
