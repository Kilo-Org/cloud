import { type ComponentProps, createElement, type ReactElement, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text';
import { SectionHeader } from './section-header';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

const ACTION_BOX_CLASSES = ['shrink-0', 'max-w-full', 'flex-row'];
const ACTION_TEXT_CLASSES = ['shrink', 'font-mono-medium', 'text-[11px]', 'text-primary'];
const PHYSICAL_ALIGNMENT_CLASSES = new Set([
  'text-left',
  'text-right',
  'text-center',
  'text-justify',
]);

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('Missing SectionHeader renderer');
  }
  return renderer.root;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('SectionHeader mounted layout', () => {
  // Host props protect the layout contract; only native I4 can prove scaled glyph rendering.
  it.each([false, true])('places the action at the row outer edge with RTL=%s', isRTL => {
    i18nManager.isRTL = isRTL;
    const root = mount(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
      })
    );
    const action = root.findByProps({ accessibilityRole: 'button' });
    const text = action.find(node => Object.is(node.type, 'Text'));
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('Live now')
    );

    // The Latin display treatment is LTR-only (home-ar-loading) and is
    // asserted per direction by the letterspacing test below.
    expect((label.props.className as string).split(' ')).toEqual(
      expect.arrayContaining([
        'grow',
        'max-w-full',
        'font-mono-medium',
        'text-[10px]',
        'text-muted-foreground',
      ])
    );
    expect(label.props.numberOfLines).toBeUndefined();
    expect(label.props.allowFontScaling).not.toBe(false);
    expect(label.props.maxFontSizeMultiplier).toBeUndefined();
    expect(label.props.adjustsFontSizeToFit).not.toBe(true);
    expect(label.children).toEqual(['Live now']);
    // The tracked class stays for the Latin design; the reset lands on a joined
    // script in either direction and on RTL-script copy inside an RTL
    // interface, so this Latin label keeps its tracking (see lib/rtl-text.ts and
    // text.rtl-labels.mounted.test.tsx).
    if (isRTL) {
      expect(label.props.style).toContainEqual({ writingDirection: 'rtl' });
      expect(label.props.style).not.toContainEqual({ letterSpacing: 0 });
      expect(text.props.style).not.toContainEqual({ letterSpacing: 0 });
    } else {
      expect(label.props.style).toBeUndefined();
      expect(text.props.style).toBeUndefined();
    }

    // The action copy must sit at the row's end in both directions: the row
    // packs every flex line to its end (`justify-end`) and only the label grows,
    // so a lone action box on a wrapped line still lands on the row's outer edge
    // instead of the line start that `justify-between` gives it. The box must
    // not grow too — when both children grew the row split in half and the
    // action sat at the inner edge of its half (the screen centre in Arabic)
    // instead of the margin the tab bar, cards and rows below share
    // (home-arabic-rtl, home). The layout is direction-relative and identical
    // under RTL, and the row's outer edge comes from the row's own main-axis
    // placement, never from a physical text alignment.
    const rowClasses = ((action.parent?.props.className as string | undefined) ?? '').split(' ');
    expect(rowClasses).toContain('flex-wrap');
    expect(rowClasses).toContain('justify-end');
    expect(rowClasses).not.toContain('justify-between');
    const actionBoxClasses = (action.props.className as string).split(' ');
    expect(actionBoxClasses).toEqual(expect.arrayContaining(ACTION_BOX_CLASSES));
    expect(actionBoxClasses).not.toContain('grow');
    expect(actionBoxClasses).not.toContain('justify-end');
    const actionTextClasses = (text.props.className as string).split(' ');
    expect(actionTextClasses).toEqual(expect.arrayContaining(ACTION_TEXT_CLASSES));
    expect(actionTextClasses.filter(name => PHYSICAL_ALIGNMENT_CLASSES.has(name))).toEqual([]);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.maxFontSizeMultiplier).toBeUndefined();
    expect(text.props.adjustsFontSizeToFit).not.toBe(true);
    expect(text.children).toEqual(['See all']);
  });

  // The letter-spacing reset belongs to the script: a joined script takes it in
  // either direction, so this LTR screen keeps the tracked class on the element
  // and the inline reset draws it inert. The mono family goes with it, because
  // JetBrains Mono ships no Arabic glyph (the RTL case below pins the same
  // treatment).
  it('keeps the tracked class and resets the joined-script label and action in LTR', () => {
    const root = mount(
      createElement(SectionHeader, {
        label: 'الجلسات الجارية الآن',
        actionLabel: 'عرض الكل',
        onActionPress: () => undefined,
      })
    );
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('الجلسات الجارية الآن')
    );
    const action = root.findByProps({ accessibilityRole: 'button' });
    const actionText = action.find(node => Object.is(node.type, 'Text'));

    expect((label.props.className as string).split(' ')).toContain('tracking-[1.5px]');
    expect(label.props.style).toContainEqual({ letterSpacing: 0 });
    expect(actionText.props.style).toContainEqual({ letterSpacing: 0 });
    expect((actionText.props.className as string).split(' ')).not.toContain('font-mono-medium');
  });

  it('renders Arabic labels without the mono family or letter spacing in RTL', () => {
    i18nManager.isRTL = true;
    const root = mount(
      createElement(SectionHeader, {
        label: 'الجلسات الجارية الآن',
        actionLabel: 'عرض الكل',
        onActionPress: () => undefined,
      })
    );
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('الجلسات الجارية الآن')
    );
    const action = root.findByProps({ accessibilityRole: 'button' });
    const text = action.find(node => Object.is(node.type, 'Text'));

    for (const node of [label, text]) {
      const classes = (node.props.className as string).split(' ');
      expect(classes.some(token => token.startsWith('font-mono'))).toBe(false);
      expect(node.props.style).toContainEqual({ writingDirection: 'rtl' });
      expect(node.props.style).toContainEqual({ letterSpacing: 0 });
    }
    expect(label.children).toEqual(['الجلسات الجارية الآن']);
    expect(text.children).toEqual(['عرض الكل']);
  });

  it.each([{ isRTL: false }, { isRTL: true }])(
    'aligns the action with the row edges, never with a physical text align, with RTL=$isRTL',
    ({ isRTL }) => {
      // React Native swaps `textAlign: 'left'` and `'right'` under RTL (Android
      // maps 'left' to Gravity.RIGHT), so a physical alignment would pin the
      // action to the inner edge of its box and float "See all" away from the
      // row end in Arabic.
      i18nManager.isRTL = isRTL;
      const root = mount(
        createElement(SectionHeader, {
          label: 'Live now',
          actionLabel: 'See all',
          onActionPress: () => undefined,
        })
      );
      const classes = root
        .findAll(node => typeof node.props.className === 'string')
        .flatMap(node => (node.props.className as string).split(' '));

      expect(classes.filter(name => PHYSICAL_ALIGNMENT_CLASSES.has(name))).toEqual([]);
      expect(classes).not.toContain('text-left');
      expect(classes).not.toContain('text-right');
    }
  );

  // Finding home-ar-loading: the Arabic section labels carried the Latin
  // uppercase letter-spacing, whose glyph gaps break a cursive script's joins
  // ('ال جلسا ت'). The display treatment is LTR-only.
  it.each([
    { isRTL: false, tracked: true },
    { isRTL: true, tracked: false },
  ])('letterspaces the section labels only outside RTL (RTL=$isRTL)', ({ isRTL, tracked }) => {
    i18nManager.isRTL = isRTL;
    const root = mount(
      createElement(SectionHeader, {
        label: 'الجلسات الجارية الآن',
        actionLabel: 'عرض الكل',
        onActionPress: () => undefined,
      })
    );
    const action = root.findByProps({ accessibilityRole: 'button' });
    const text = action.find(node => Object.is(node.type, 'Text'));
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('الجلسات الجارية الآن')
    );

    for (const node of [label, text]) {
      const classes = (node.props.className as string).split(' ');
      if (tracked) {
        expect(classes).toEqual(expect.arrayContaining(['uppercase', 'tracking-[1.5px]']));
      } else {
        expect(classes).not.toContain('uppercase');
        expect(classes.some(name => name.startsWith('tracking'))).toBe(false);
      }
    }
  });

  // The action's display treatment intentionally branches on direction (the
  // LTR-only letterspacing); the layout must not.
  it('does not branch the action layout on direction', () => {
    function actionLayout(isRTL: boolean) {
      i18nManager.isRTL = isRTL;
      const root = mount(
        createElement(SectionHeader, {
          label: 'Live now',
          actionLabel: 'See all',
          onActionPress: () => undefined,
        })
      );
      const action = root.findByProps({ accessibilityRole: 'button' });
      const text = action.find(node => Object.is(node.type, 'Text'));
      return {
        box: action.props.className as string,
        physicalAlignment: (text.props.className as string)
          .split(' ')
          .filter(name => PHYSICAL_ALIGNMENT_CLASSES.has(name)),
      };
    }

    const ltr = actionLayout(false);
    act(() => renderer?.unmount());
    renderer = undefined;
    const rtl = actionLayout(true);

    expect(rtl).toEqual(ltr);
  });

  it('keeps the complete accessible action name and activates the supplied destination', () => {
    function Destination() {
      const [showAll, setShowAll] = useState(false);
      return showAll
        ? createElement(Text, null, 'All sessions')
        : createElement(SectionHeader, {
            label: 'Live now',
            actionLabel: 'See all',
            onActionPress: () => {
              setShowAll(true);
            },
          });
    }
    const root = mount(createElement(Destination));
    const action = root.findByProps({ accessibilityRole: 'button' });
    expect(action.props.accessibilityLabel).toBe('See all');
    expect(action.props.hitSlop).toBe(8);
    expect(action.props.className).toContain('active:opacity-70');

    act(() => {
      (action.props.onPress as () => void)();
    });

    expect(root.find(node => Object.is(node.type, 'Text')).children).toEqual(['All sessions']);
    expect(root.findAll(node => Object.is(node.type, 'Pressable'))).toHaveLength(0);
  });

  it.each<Partial<ComponentProps<typeof SectionHeader>>>([
    {},
    { actionLabel: 'See all' },
    { onActionPress: () => undefined },
  ])('does not create an action when the label or callback is absent: %j', props => {
    const root = mount(createElement(SectionHeader, { label: 'Explore', ...props }));
    expect(root.findAll(node => Object.is(node.type, 'Pressable'))).toHaveLength(0);
    expect(root.find(node => Object.is(node.type, 'Text')).children).toEqual(['Explore']);
  });

  it('gives a notice all the free space and keeps the action at the outer edge', () => {
    // Field defect (iPhone 17 Pro): a growing label took half the free space
    // and cut "Connection lost" to "Connection l…" beside empty space.
    const root = mount(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
        notice: createElement(Text, null, 'Connection lost'),
      })
    );
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('Live now')
    );
    const slot = root.find(
      node =>
        Object.is(node.type, 'View') &&
        node.findAll(
          child => Object.is(child.type, 'Text') && child.children.includes('Connection lost')
        ).length > 0 &&
        String(node.props.className).includes('basis-0')
    );
    expect((label.props.className as string).split(' ')).not.toContain('grow');
    expect((slot.props.className as string).split(' ')).toEqual(
      expect.arrayContaining(['grow', 'basis-0', 'min-w-0'])
    );
    expect(root.findByProps({ accessibilityRole: 'button' })).toBeDefined();
  });
});
