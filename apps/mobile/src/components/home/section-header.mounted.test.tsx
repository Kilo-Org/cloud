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
const ACTION_TEXT_CLASSES = [
  'shrink',
  'font-mono-medium',
  'text-[11px]',
  'tracking-[1.5px]',
  'uppercase',
  'text-primary',
];
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

    expect((label.props.className as string).split(' ')).toEqual(
      expect.arrayContaining([
        'grow',
        'max-w-full',
        'font-mono-medium',
        'text-[10px]',
        'tracking-[1.5px]',
        'uppercase',
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

  it('does not branch the action layout on direction', () => {
    function actionClasses(isRTL: boolean) {
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
      return { box: action.props.className as string, text: text.props.className as string };
    }

    const ltr = actionClasses(false);
    act(() => renderer?.unmount());
    renderer = undefined;
    const rtl = actionClasses(true);

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
