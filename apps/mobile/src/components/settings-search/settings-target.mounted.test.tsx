import { createElement, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { ScrollViewInstance } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';

import { defineSetting } from '@/lib/settings-search/definitions';
import {
  SettingsSearchScrollView,
  SettingsSearchTargetScope,
  SettingsTarget,
} from './settings-target';

const fake = vi.hoisted(() => {
  const content = { node: 'content' };
  const scroll = {
    getInnerViewRef: () => content,
    getInnerViewNode: () => undefined,
    scrollTo: vi.fn(),
  };
  return { content, scroll };
});

vi.mock('react-native', () => ({
  View: 'View',
}));
// Stands in for the wrapper: it hands the scope the instance the real scroll
// view's forwarded ref would hold, and records the props it received.
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: ({
    ref,
    children,
    ...props
  }: { ref?: { current: unknown } | null; children?: ReactNode } & Record<string, unknown>) => {
    if (ref != null) {
      ref.current = fake.scroll;
    }
    return createElement('TabScroll', props, children);
  },
}));

const system = defineSetting('appearance.system', 'preferences.appearanceSystem');
const dark = defineSetting('appearance.dark', 'preferences.appearanceDark');

let renderer: ReactTestRenderer | undefined = undefined;

/** A ref holding a test double: the reveal path reads only its three members. */
function scrollTarget(instance: unknown): RefObject<ScrollViewInstance | null> {
  return { current: instance as ScrollViewInstance };
}

function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (renderer === undefined) {
    throw new Error('Missing renderer');
  }
  return renderer.root;
}

function row(testID = 'row') {
  return createElement('Row', { testID });
}

function overlays(root: ReactTestInstance) {
  return root.findAll(
    node =>
      Object.is(node.type, 'View') && String(node.props.className).includes('border-primary')
  );
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('SettingsTarget', () => {
  it('returns the row untouched without an active target scope', () => {
    const root = mount(
      createElement(SettingsTarget, { item: system }, row('alone'))
    );

    expect(root.findByProps({ testID: 'alone' })).toBeTruthy();
    expect(root.findAll(node => Object.is(node.type, 'View'))).toEqual([]);
    expect(overlays(root)).toEqual([]);
  });

  it('reveals and highlights the matching row without changing its node', () => {
    const root = mount(
      createElement(
        SettingsSearchTargetScope,
        { settingsTarget: 'appearance.dark', scrollRef: scrollTarget(fake.scroll) },
        createElement(SettingsTarget, { item: dark }, row())
      )
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toHaveLength(1);
    const wrapper = root.findAll(
      node => Object.is(node.type, 'View') && node.props.className === 'relative'
    )[0];
    expect(wrapper?.props.accessibilityRole).toBeUndefined();
    expect(wrapper?.props.accessible).toBeUndefined();
  });

  it('leaves a non-matching row and its group geometry alone', () => {
    const root = mount(
      createElement(
        SettingsSearchTargetScope,
        { settingsTarget: 'appearance.system', scrollRef: scrollTarget(fake.scroll) },
        createElement(SettingsTarget, { item: dark }, row())
      )
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toEqual([]);
    expect(root.findAll(node => Object.is(node.type, 'View'))).toEqual([]);
  });

  it('matches an alias id for a control shared by several definitions', () => {
    const root = mount(
      createElement(
        SettingsSearchTargetScope,
        { settingsTarget: 'appearance.dark', scrollRef: scrollTarget(fake.scroll) },
        createElement(
          SettingsTarget,
          { item: system, targetIds: ['appearance.dark', 'appearance.light'] },
          row()
        )
      )
    );

    expect(overlays(root)).toHaveLength(1);
  });
});

describe('SettingsSearchScrollView', () => {
  it('forwards tab-scroll props and the scroll ref while supplying the target', () => {
    const forwarded = scrollTarget(null);
    const root = mount(
      createElement(
        SettingsSearchScrollView,
        {
          settingsTarget: 'appearance.dark',
          ref: forwarded,
          contentContainerClassName: 'gap-6 px-4 pt-3',
          keyboardShouldPersistTaps: 'handled',
        },
        createElement(SettingsTarget, { item: dark }, row())
      )
    );

    const scroller = root.findByType('TabScroll');
    expect(scroller.props.contentContainerClassName).toBe('gap-6 px-4 pt-3');
    expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
    expect(forwarded.current).toBe(fake.scroll);
    expect(overlays(root)).toHaveLength(1);
  });

  it('renders the plain body when the route names no target', () => {
    const root = mount(
      createElement(
        SettingsSearchScrollView,
        { contentContainerClassName: 'gap-6' },
        createElement(SettingsTarget, { item: dark }, row())
      )
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toEqual([]);
  });
});
