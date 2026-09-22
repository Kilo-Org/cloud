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

const ACTION_BOX_CLASSES = ['grow', 'max-w-full', 'flex-row', 'justify-end'];
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
    // The tracked class stays for the Latin design; the RTL letter-spacing
    // reset applies to Arabic-script copy only, so this Latin label keeps its
    // tracking (see lib/rtl-text.ts and text.rtl-labels.mounted.test.tsx).
    if (isRTL) {
      expect(label.props.style).toContainEqual({ writingDirection: 'rtl' });
      expect(label.props.style).not.toContainEqual({ letterSpacing: 0 });
      expect(text.props.style).not.toContainEqual({ letterSpacing: 0 });
    } else {
      expect(label.props.style).toBeUndefined();
      expect(text.props.style).toBeUndefined();
    }

    expect((action.parent?.props.className as string | undefined)?.split(' ')).toContain(
      'flex-wrap'
    );
    // The action copy must sit at the row's end in both directions, so the box
    // is a row that places its content at the main-axis end, and the layout is
    // direction-relative and identical under RTL. The row's outer edge comes
    // from the action box's flex direction, never from a physical text
    // alignment.
    expect((action.props.className as string).split(' ')).toEqual(
      expect.arrayContaining(ACTION_BOX_CLASSES)
    );
    const actionTextClasses = (text.props.className as string).split(' ');
    expect(actionTextClasses).toEqual(expect.arrayContaining(ACTION_TEXT_CLASSES));
    expect(actionTextClasses.filter(name => PHYSICAL_ALIGNMENT_CLASSES.has(name))).toEqual([]);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.maxFontSizeMultiplier).toBeUndefined();
    expect(text.children).toEqual(['See all']);
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
});
