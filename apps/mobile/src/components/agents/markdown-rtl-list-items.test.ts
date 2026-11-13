import { describe, expect, it } from 'vitest';

import { rtlListItems } from './markdown-rtl-list-items';

const MARK = '\u200F';

describe('rtlListItems', () => {
  it('names the start edge after a bullet marker', () => {
    expect(rtlListItems('- The layout holds')).toBe(`- ${MARK}The layout holds`);
  });

  it('names it after an ordered marker', () => {
    expect(rtlListItems('1. First\n2) Second')).toBe(`1. ${MARK}First\n2) ${MARK}Second`);
  });

  it('keeps a task checkbox at the start of the item', () => {
    expect(rtlListItems('- [ ] Check the layout\n- [x] Ship it')).toBe(
      `- [ ] ${MARK}Check the layout\n- [x] ${MARK}Ship it`
    );
  });

  it('names it inside a nested item and a blockquote item', () => {
    expect(rtlListItems('  - Nested')).toBe(`  - ${MARK}Nested`);
    expect(rtlListItems('> - Quoted')).toBe(`> - ${MARK}Quoted`);
  });

  it('leaves a marker with no content alone', () => {
    expect(rtlListItems('- \n-')).toBe('- \n-');
  });

  it('leaves prose and headings alone', () => {
    const value = '# Release notes\n\nThe settings screen keeps its layout.';
    expect(rtlListItems(value)).toBe(value);
  });

  it('keeps a list-shaped line inside a fence exactly', () => {
    const value = '```md\n- item\n```\n- item';
    expect(rtlListItems(value)).toBe(`\`\`\`md\n- item\n\`\`\`\n- ${MARK}item`);
  });

  it('keeps a fence open until a run of the same mark closes it', () => {
    const value = '~~~\n- item\n~~~\n- item';
    expect(rtlListItems(value)).toBe(`~~~\n- item\n~~~\n- ${MARK}item`);
  });

  it('keeps an indented code block exactly', () => {
    const value = 'Example:\n\n    - item\n\n- item';
    expect(rtlListItems(value)).toBe(`Example:\n\n    - item\n\n- ${MARK}item`);
  });

  it('returns markdown without a list unchanged', () => {
    const value = 'A reply with no list.\n\n> quoted\n';
    expect(rtlListItems(value)).toBe(value);
  });
});
