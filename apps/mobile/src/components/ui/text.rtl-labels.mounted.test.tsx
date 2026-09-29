import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('Missing text renderer');
  }
  return renderer.root;
}

function hostText(root: TestRenderer.ReactTestInstance) {
  return root.find(node => Object.is(node.type, 'Text'));
}

const ARABIC = 'الجلسات الجارية الآن';
// U+0870–U+089F, Arabic Extended-B: Arabic-script characters outside the
// blocks the first fix matched.
const ARABIC_EXTENDED_B = '\u0870\u089F';
// The Hebrew eyebrow copy from `he.json` (`home.agentSessions`): Hebrew is an
// RTL locale the app ships and is not Arabic script, so an Arabic-only
// predicate leaves it with the Latin tracking and mono family.
const HEBREW = 'פעילים עכשיו';
const LATIN = 'Live now';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('Text eyebrow in an RTL interface', () => {
  it('drops the mono family and letter spacing from an Arabic label', () => {
    i18nManager.isRTL = true;
    const label = hostText(mount(createElement(Text, { variant: 'eyebrow' }, ARABIC)));
    const classes = (label.props.className as string).split(' ');

    expect(classes.some(token => token.startsWith('font-mono'))).toBe(false);
    expect(classes).toEqual(expect.arrayContaining(['text-[10px]', 'text-muted-foreground']));
    expect(label.props.style).toContainEqual({ letterSpacing: 0 });
    expect(label.props.style).toContainEqual({ writingDirection: 'rtl' });
    expect(label.children).toEqual([ARABIC]);
  });

  it('drops the mono family and letter spacing from an Extended-B-only label', () => {
    i18nManager.isRTL = true;
    const label = hostText(mount(createElement(Text, { variant: 'eyebrow' }, ARABIC_EXTENDED_B)));
    const classes = (label.props.className as string).split(' ');

    expect(classes.some(token => token.startsWith('font-mono'))).toBe(false);
    expect(label.props.style).toContainEqual({ letterSpacing: 0 });
    expect(label.children).toEqual([ARABIC_EXTENDED_B]);
  });

  it('drops the mono family and letter spacing from a Hebrew label', () => {
    i18nManager.isRTL = true;
    const label = hostText(mount(createElement(Text, { variant: 'eyebrow' }, HEBREW)));
    const classes = (label.props.className as string).split(' ');

    expect(classes.some(token => token.startsWith('font-mono'))).toBe(false);
    expect(classes).not.toContain('tracking-[1.5px]');
    expect(label.props.style).toContainEqual({ letterSpacing: 0 });
    expect(label.props.style).toContainEqual({ writingDirection: 'rtl' });
    expect(label.children).toEqual([HEBREW]);
  });

  it('keeps the tracked mono design for a Latin label', () => {
    i18nManager.isRTL = true;
    const label = hostText(mount(createElement(Text, { variant: 'eyebrow' }, LATIN)));
    const classes = (label.props.className as string).split(' ');

    expect(classes).toContain('font-mono-medium');
    expect(classes).toContain('tracking-[1.5px]');
    expect(label.props.style).toEqual([{ writingDirection: 'rtl' }, undefined, undefined]);
  });

  it('keeps the mono family and adds no letter spacing for Arabic in an LTR interface', () => {
    i18nManager.isRTL = false;
    const label = hostText(mount(createElement(Text, { variant: 'eyebrow' }, ARABIC)));
    const classes = (label.props.className as string).split(' ');

    expect(classes).toContain('font-mono-medium');
    expect(label.props.style).toBeUndefined();
  });

  it('applies the same rule to the Eyebrow wrapper', () => {
    i18nManager.isRTL = true;
    const label = hostText(mount(createElement(Eyebrow, null, ARABIC)));
    const classes = (label.props.className as string).split(' ');

    expect(classes.some(token => token.startsWith('font-mono'))).toBe(false);
    expect(label.props.style).toContainEqual({ letterSpacing: 0 });
    expect(label.children).toEqual([ARABIC]);
  });
});
