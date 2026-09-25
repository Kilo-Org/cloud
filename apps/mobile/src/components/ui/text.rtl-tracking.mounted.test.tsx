import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { RTL_NO_LETTER_SPACING, RTL_WRITING_DIRECTION } from '@/lib/rtl-text';

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
    throw new Error('Missing Text renderer');
  }
  return renderer.root;
}

/** The native Text host `Text` renders, whose style the platform draws. */
function hostText(root: TestRenderer.ReactTestInstance) {
  return root.find(node => Object.is(node.type, 'Text'));
}

function hostStyle(root: TestRenderer.ReactTestInstance): Record<string, unknown>[] {
  const style = (hostText(root).props.style ?? []) as (Record<string, unknown> | undefined)[];
  return style.filter(entry => entry !== undefined);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

// The tracked classes the home screen labels carry: the eyebrow
// ("الجلسات الجارية الآن", "استكشف"), the section-header action ("عرض الكل")
// and the bottom tab labels.
const TRACKED_CLASSES = ['tracking-[1.5px]', 'tracking-[0.2px]'] as const;

// The Hebrew eyebrow copy from `he.json` (`home.agentSessions`). Hebrew is a
// shipped RTL locale and not Arabic script, so the reset has to reach it too.
const HEBREW = 'פעילים עכשיו';

describe('Text tracked labels in RTL', () => {
  it.each(TRACKED_CLASSES)(
    'draws %s with no letter spacing while a tracked class stays on the element',
    trackedClass => {
      i18nManager.isRTL = true;
      const root = mount(createElement(Text, { className: trackedClass }, 'استكشف'));

      expect(hostText(root).props.className as string).toContain(trackedClass);
      expect(root.findAll(node => Object.is(node.type, 'Text'))).toHaveLength(1);
      expect(hostStyle(root)).toContainEqual(RTL_WRITING_DIRECTION);
      expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
    }
  );

  it('resets a caller-tracked Hebrew label, not only Arabic', () => {
    i18nManager.isRTL = true;
    const root = mount(createElement(Text, { className: 'tracking-[0.2px]' }, HEBREW));

    expect(hostText(root).props.className as string).toContain('tracking-[0.2px]');
    expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
  });

  it('drops the eyebrow Latin display treatment from Hebrew copy', () => {
    i18nManager.isRTL = true;
    const root = mount(createElement(Text, { variant: 'eyebrow' }, HEBREW));

    const className = hostText(root).props.className as string;
    expect(className.split(' ')).not.toContain('uppercase');
    expect(className).not.toContain('tracking');
    expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
  });

  it('leaves no non-zero letter spacing on a tracked label in any class order', () => {
    i18nManager.isRTL = true;
    const root = mount(
      createElement(
        Text,
        { variant: 'eyebrow', className: 'grow tracking-[1.5px] text-primary' },
        'استكشف'
      )
    );

    expect(
      hostStyle(root)
        .map(entry => entry.letterSpacing)
        .filter(spacing => spacing !== undefined)
    ).toEqual([0]);
  });

  it('keeps the caller style after the RTL defaults', () => {
    i18nManager.isRTL = true;
    const callerStyle = { color: '#ff0000' };
    // RTL-script copy, the copy the merged rule resets (text.rtl-labels:
    // Latin labels keep their tracking); the caller style still lands last.
    const root = mount(
      createElement(Text, { className: 'tracking-[1.5px]', style: callerStyle }, 'استكشف')
    );

    expect(hostStyle(root)).toContainEqual(callerStyle);
    expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
  });

  it('does not touch a tracked label in an LTR interface', () => {
    i18nManager.isRTL = false;
    const root = mount(createElement(Text, { className: 'tracking-[1.5px]' }, 'Explore'));

    expect(hostText(root).props.className as string).toContain('tracking-[1.5px]');
    expect(hostText(root).props.style).toBeUndefined();
  });

  it('drops the Eyebrow display treatment and still resets letter spacing in RTL', () => {
    // The eyebrow's tracking class is LTR-only (text.tsx EYEBROW_LATIN_DISPLAY):
    // an RTL eyebrow drops it and relies on the RTL letter-spacing reset.
    i18nManager.isRTL = true;
    const root = mount(createElement(Eyebrow, null, 'استكشف'));

    // Arabic-script copy drops the tracked class and the mono family in an RTL
    // interface (`withoutMonoFamily`): a zero letter spacing alone does not
    // keep a cursive script's joins (text.rtl-labels, text.mounted).
    // The eyebrow's Latin display treatment (uppercase + tracking) is LTR-only
    // (see `Text`'s eyebrow variant and `SectionHeader`): the variant owns its
    // display classes, so an RTL eyebrow drops them — it carries no tracked
    // class of its own (the rule `text.mounted.test.tsx` pins) — and drops the
    // capitals and tracked class instead of carrying a class the interface
    // language never asked for (`section-header.mounted.test.tsx`) rather than
    // keeping them like a caller-supplied tracked class. Assert on the class
    // list and on the rendered string alike: the token list pins the exact
    // classes, the substring check catches a `tracking` that shows up only
    // inside another token, and the LTR-only class is pinned by name. No
    // uppercase or tracked class is left for the shared RTL reset to neutralize
    // on this label — the reset style is its whole treatment — and the zero
    // letter-spacing reset still lands.
    expect(hostText(root).props.className as string).not.toContain('tracking-[1.5px]');
    const className = hostText(root).props.className as string;
    const classes = className.split(' ');
    expect(classes).not.toContain('uppercase');
    expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
    expect(className).not.toContain('uppercase');
    expect(className).not.toContain('tracking-[1.5px]');
    expect(className).not.toContain('tracking');
    expect(hostText(root).props.className as string).not.toContain('tracking-');
    // The mono family goes with them: JetBrains Mono ships no Arabic glyphs, so
    // the RTL eyebrow drops `font-mono-medium` as well (`withoutMonoFamily`),
    // matching the LTR-only display treatment it just lost.
    expect(classes.some(name => name.startsWith('font-mono'))).toBe(false);
    expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
  });

  it('neutralizes a caller-supplied tracked class on the shared Eyebrow label', () => {
    i18nManager.isRTL = true;
    // The eyebrow variant owns its Latin display classes, so an RTL eyebrow
    // drops them (the rule `text.mounted.test.tsx` pins) rather than keeping
    // them like a caller-supplied tracked class; a caller-supplied tracked
    // class stays on the element and the zero letter-spacing reset neutralizes
    // it (see rtl-text.ts).
    const root = mount(createElement(Eyebrow, { className: 'tracking-[1.5px]' }, 'استكشف'));

    const classes = (hostText(root).props.className as string).split(' ');
    expect(classes).not.toContain('uppercase');
    expect(classes).toContain('tracking-[1.5px]');
    // The variant's own letter-spaced class is dropped, so the caller's is the
    // only tracking class the label carries.
    expect(classes.filter(name => name.startsWith('tracking'))).toHaveLength(1);
    expect(hostStyle(root)).toContainEqual(RTL_NO_LETTER_SPACING);
  });
});
