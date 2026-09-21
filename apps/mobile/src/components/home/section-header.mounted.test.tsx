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
  it.each([
    { isRTL: false, alignment: 'text-right' },
    { isRTL: true, alignment: 'text-left' },
  ])('gives both labels spare width and wrapping with RTL=$isRTL', ({ isRTL, alignment }) => {
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
    if (isRTL) {
      expect(label.props.style).toContainEqual({ writingDirection: 'rtl' });
    }

    expect((action.parent?.props.className as string | undefined)?.split(' ')).toContain(
      'flex-wrap'
    );
    expect((action.props.className as string).split(' ')).toEqual(
      expect.arrayContaining(['grow', 'max-w-full'])
    );
    expect((text.props.className as string).split(' ')).toEqual(
      expect.arrayContaining([alignment, 'font-mono-medium', 'text-[11px]', 'text-primary'])
    );
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.maxFontSizeMultiplier).toBeUndefined();
    expect(text.children).toEqual(['See all']);
  });

  // The inline override only has a class to beat in LTR: there the eyebrow
  // variant and the action keep `tracking-[1.5px]`, and the joined-script
  // children still get `letterSpacing: 0` on top of it.
  it('clears the tracked letter-spacing on the Arabic label and action', () => {
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
  });

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
