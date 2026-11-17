import { type ComponentProps, createElement, type ReactElement, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text';
import {
  SECTION_ACTION_BOX_CLASS,
  SECTION_HEADER_ROW_PADDING_CLASS,
  textActionTargetClass,
} from '@/lib/a11y/tap-target';
import { SectionHeader } from './section-header';
import { SectionHeaderSkeleton } from './section-header-skeleton';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Platform: platform,
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
// The skeleton owns no geometry of its own; the header's row classes are what
// this suite compares, so the loading fill is a plain host node here.
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

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
  platform.OS = 'ios';
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
    // Label and action copy sit on the row's content bottom edge, not its
    // centre: a 48 dp action box would otherwise hold the label half a box away
    // from the rows it names (home section-label gap).
    expect(rowClasses.filter(name => name.startsWith('items-'))).toEqual(['items-end']);
    expect(actionBoxClasses).toContain('items-end');
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
    expect(action.props.className).toContain('min-h-[44px]');
    expect(action.props.className).toContain('active:opacity-70');
    expect(action.props.hitSlop).toBeUndefined();

    act(() => {
      (action.props.onPress as () => void)();
    });

    expect(root.find(node => Object.is(node.type, 'Text')).children).toEqual(['All sessions']);
    expect(root.findAll(node => Object.is(node.type, 'Pressable'))).toHaveLength(0);
  });

  it.each([
    ['ios', 'min-h-[44px]', 'min-w-[44px]'],
    ['android', 'min-h-[48px]', 'min-w-[48px]'],
  ])(
    'gives the action its own %s touch-target frame on both axes, visible or hidden',
    (os, height, width) => {
      // Field defect: the action's only child is one 11px label line, so its own
      // rect was that line (~15pt on device) and a size audit reads exactly that
      // rect — hitSlop never widens it. The width floor matters too because the
      // hit slop is gone: a short label is a couple of glyphs wide. The hidden
      // action keeps the same box, so hiding the action still cannot resize the
      // header.
      platform.OS = os;
      const props = { label: 'Live now', actionLabel: 'See all', onActionPress: () => undefined };
      const action = mount(createElement(SectionHeader, props)).findByProps({
        accessibilityRole: 'button',
      });
      const frame = `${height} ${width}`;
      expect(action.props.className).toContain(frame);
      expect(action.props.className).toContain('justify-center');
      expect(action.props.hitSlop).toBeUndefined();
      act(() => renderer?.unmount());
      renderer = undefined;
      const hidden = mount(createElement(SectionHeader, { ...props, actionHidden: true })).find(
        node => Object.is(node.type, 'Pressable')
      );
      expect(hidden.props.className).toContain(frame);
    }
  );

  it.each<Partial<ComponentProps<typeof SectionHeader>>>([
    {},
    { actionLabel: 'See all' },
    { onActionPress: () => undefined },
  ])('does not create an action when the label or callback is absent: %j', props => {
    const root = mount(createElement(SectionHeader, { label: 'Explore', ...props }));
    expect(root.findAll(node => Object.is(node.type, 'Pressable'))).toHaveLength(0);
    expect(root.find(node => Object.is(node.type, 'Text')).children).toEqual(['Explore']);
    // No tall child here, and the same rule still puts the label on the row's
    // content edge: one label-to-content gap with or without an action.
    const row = root.find(node => Object.is(node.type, 'View'));
    expect(String(row.props.className).split(' ')).toContain('items-end');
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
    // The divider keeps its own centring against a 48 dp notice action.
    const divider = root.find(
      node => Object.is(node.type, 'View') && String(node.props.className).includes('w-px')
    );
    expect((divider.props.className as string).split(' ')).toContain('self-center');
  });

  it('announces the section label as a heading', () => {
    // A section label is one of the few headings a long settings screen has; a
    // reader navigates by jumping between them, so every one of them carries the
    // role without the caller opting in.
    const root = mount(createElement(SectionHeader, { label: 'Explore' }));
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('Explore')
    );
    expect(label.props.accessibilityRole).toBe('header');
  });

  it('leads the label with an optional icon on the label line', () => {
    const root = mount(
      createElement(SectionHeader, {
        label: 'Inbox',
        icon: createElement('Icon', { size: 16 }),
      })
    );
    const icon = root.findByType('Icon');
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('Inbox')
    );
    // The icon shares the label's flex line, so it cannot push the label onto a
    // second row, and the label's own width gives way to it.
    const line = root.find(
      node =>
        Object.is(node.type, 'View') &&
        String(node.props.className).includes('min-w-0 flex-row items-center gap-2')
    );
    expect(
      line.findAll(child => Object.is(child.type, 'Text') && child.children.includes('Inbox'))
    ).toHaveLength(1);
    const lineClasses = String(line.props.className).split(' ');
    expect(lineClasses).toContain('grow');
    expect((label.props.className as string).split(' ')).toContain('shrink');
    expect((label.props.className as string).split(' ')).not.toContain('grow');
  });

  it('keeps the action box but makes it inert and announces the disabled state', () => {
    const props = {
      label: 'Repositories',
      actionLabel: 'Manage',
      onActionPress: () => undefined,
    };
    const enabled = mount(createElement(SectionHeader, props)).findByProps({
      accessibilityRole: 'button',
    });
    const enabledClasses = enabled.props.className;
    act(() => renderer?.unmount());
    renderer = undefined;

    const root = mount(createElement(SectionHeader, { ...props, actionDisabled: true }));
    const disabled = root.findByProps({ accessibilityRole: 'button' });
    const ink = String(disabled.find(node => Object.is(node.type, 'Text')).props.className).split(
      ' '
    );

    expect(disabled.props.disabled).toBe(true);
    expect(disabled.props.accessibilityState).toEqual({ disabled: true });
    // The name stays readable, so the reader hears why the action is inert.
    expect(disabled.props.accessibilityLabel).toBe('Manage');
    // Same frame: a write that ends cannot resize the header.
    expect(disabled.props.className).toBe(enabledClasses);
    expect(ink).toContain('text-muted-foreground');
    expect(ink).not.toContain('text-primary');
  });

  it('holds the header row, with and without an action, while it loads', () => {
    // The renderer's instances read their fiber, which the unmount at the end of
    // each shape clears, so every class string is copied out while it is live.
    const shape = (element: ReactElement) => {
      const root = mount(element);
      const row = root.find(node => Object.is(node.type, 'View'));
      const result = {
        row: String(row.props.className).split(' '),
        views: root
          .findAll(node => Object.is(node.type, 'View'))
          .map(node => String(node.props.className).split(' ')),
        bars: root
          .findAll(node => Object.is(node.type, 'Skeleton'))
          .map(node => String(node.props.className).split(' ')),
      };
      act(() => renderer?.unmount());
      renderer = undefined;
      return result;
    };

    const plainHeader = shape(createElement(SectionHeader, { label: 'Explore' }));
    const plainSkeleton = shape(createElement(SectionHeaderSkeleton));
    expect(plainSkeleton.row).toEqual(plainHeader.row);
    expect(plainSkeleton.bars).toHaveLength(1);

    const withActionHeader = shape(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
      })
    );
    const withActionSkeleton = shape(createElement(SectionHeaderSkeleton, { action: true }));
    expect(withActionSkeleton.row).toEqual(withActionHeader.row);
    expect(withActionSkeleton.bars).toHaveLength(2);
    // The action bar reserves the same frame the real action renders, so the
    // action cannot grow the header when it arrives.
    expect(withActionSkeleton.bars[1]).toEqual(
      expect.arrayContaining(textActionTargetClass().split(' '))
    );

    const airHeader = shape(
      createElement(SectionHeader, { label: 'Explore', reserveLabelAir: true })
    );
    const airSkeleton = shape(createElement(SectionHeaderSkeleton, { reserveLabelAir: true }));
    expect(airSkeleton.row).toEqual(airHeader.row);
    expect(airSkeleton.row).toContain(SECTION_HEADER_ROW_PADDING_CLASS);
    // The label air box is the header's own height on both sides of the swap.
    for (const loadingOrLoaded of [airHeader, airSkeleton]) {
      expect(loadingOrLoaded.views.some(classes => classes.includes('min-h-[28px]'))).toBe(true);
    }

    const actionAirSkeleton = shape(
      createElement(SectionHeaderSkeleton, { action: true, reserveLabelAir: true })
    );
    expect(actionAirSkeleton.bars[1]).toEqual(
      expect.arrayContaining(SECTION_ACTION_BOX_CLASS.split(' '))
    );

    const insetSkeleton = shape(createElement(SectionHeaderSkeleton, { inset: true }));
    expect(insetSkeleton.row).toContain('px-4');
  });
});
