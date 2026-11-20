import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text';
import {
  hostText,
  mountTextTree,
  unmountTextTree,
} from '@/components/ui/text.mounted.test-helpers';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', async () => {
  // A `vi.mock` factory runs before this file's imports are initialised, so the
  // shared flatten comes in dynamically. The primitive reads a caller's own base
  // direction through `StyleSheet.flatten` (`pinsTextDirection`).
  const { flattenStyle: flatten } = await import('@/test/style-sheet-mock');
  return {
    I18nManager: i18nManager,
    StyleSheet: { create: (styles: unknown) => styles, flatten },
    Text: 'Text',
  };
});
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

// The mark is a right-to-left mark (U+200F): a strong character with no width
// that names the interface's start edge for the paragraph.
const MARK = '\u200F';
// The Bitbucket denial sentence: it opens on a Latin product name and then
// holds Arabic words, which Android would otherwise lay out left to right.
const MIXED = 'Bitbucket غير متصل. يمكن لمالكي المؤسسة ربطه.';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  unmountTextTree();
});

// App copy in a right-to-left interface takes the interface's start edge: React
// Native never sets a text view's own direction, and Android resolves a
// paragraph from its first strong character, so copy that opens on a Latin
// product name carries a right-to-left mark (`rtlBaseMarkedChildren`).
describe('Text app copy base mark', () => {
  it('marks a label that opens on a Latin product name but holds Arabic copy', () => {
    i18nManager.isRTL = true;
    const root = mountTextTree(createElement(Text, null, MIXED));

    expect((hostText(root).children[0] as string).startsWith(MARK)).toBe(true);
  });

  it('leaves a label that already opens right to left unmarked', () => {
    i18nManager.isRTL = true;
    const root = mountTextTree(createElement(Text, null, 'استكشف'));

    expect(hostText(root).children).toEqual(['استكشف']);
  });

  it('leaves Latin-only copy unmarked, so its full stop stays on the word', () => {
    i18nManager.isRTL = true;
    const root = mountTextTree(createElement(Text, null, 'Sentry.'));

    expect(hostText(root).children).toEqual(['Sentry.']);
  });

  it('adds no mark in a left-to-right interface', () => {
    i18nManager.isRTL = false;
    const root = mountTextTree(createElement(Text, null, MIXED));

    expect(hostText(root).children).toEqual([MIXED]);
  });

  // Content names its own first letter's direction, so an English sentence in
  // an Arabic interface keeps its left edge and takes no mark.
  it('adds no mark to content, which names its own direction', () => {
    i18nManager.isRTL = true;
    const root = mountTextTree(
      createElement(Text, { direction: 'auto' }, 'Send the report to your team.')
    );

    expect(hostText(root).children).toEqual(['Send the report to your team.']);
  });

  // A caller that names a base direction has said what the paragraph's direction
  // is: the value is a path, a command or an identifier pinned with
  // `LTR_TEXT_DIRECTION`, and a mark would lay it out in an order its reader did
  // not ask for (`pinsTextDirection`).
  it('adds no mark when the caller pins its own base direction', () => {
    i18nManager.isRTL = true;
    const root = mountTextTree(createElement(Text, { style: { direction: 'ltr' } }, MIXED));

    expect(hostText(root).children).toEqual([MIXED]);
  });

  it('adds no mark through a caller pin inside a style array', () => {
    i18nManager.isRTL = true;
    const root = mountTextTree(
      createElement(Text, { style: [{ letterSpacing: 0 }, { writingDirection: 'ltr' }] }, MIXED)
    );

    expect(hostText(root).children).toEqual([MIXED]);
  });

  // `Slot.Text` takes one element child and passes the props to it, so the
  // primitive must not add a sibling in front of that child.
  it('adds no mark with asChild, which takes one element child', () => {
    i18nManager.isRTL = true;
    const root = mountTextTree(
      createElement(Text, { asChild: true }, createElement('Text', null, MIXED))
    );
    const [slot] = root.findAll(node => Object.is(node.type, 'Slot.Text'));
    const inner = slot?.children ?? [];

    expect(inner).toHaveLength(1);
    expect(hostText(root).children).toEqual([MIXED]);
  });
});
