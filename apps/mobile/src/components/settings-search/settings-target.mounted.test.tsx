import {
  createElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { type ScrollViewInstance } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
  TestRenderer,
} from '@/test/renderer';

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

type RevealNode = {
  measureLayout: (relative: unknown, onSuccess: (left: number, top: number) => void) => void;
};

/** The row wrapper instance the reveal measures, reporting a 40pt top edge. */
const revealNode = vi.hoisted(
  (): RevealNode => ({
    measureLayout: (_relative, onSuccess) => {
      onSuccess(0, 40);
    },
  })
);

vi.mock('react-native', async () => {
  // A vi.mock factory is hoisted above the module's static imports, so React is
  // imported inside it. The reveal measures through the row wrapper's own ref,
  // so the mock hands that ref a real instance: a host string gives the
  // renderer's inert node, whose `measureLayout` never reports a frame.
  const react = await import('react');
  function MockView({
    ref,
    children,
    ...props
  }: { ref?: Ref<RevealNode>; children?: ReactNode } & Record<string, unknown>) {
    react.useImperativeHandle(ref, () => revealNode, []);
    return react.createElement('View', props, children);
  }
  return { View: MockView };
});
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
    node => Object.is(node.type, 'View') && String(node.props.className).includes('border-primary')
  );
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  fake.scroll.scrollTo.mockClear();
});

/** The wrapper the active row draws around itself. */
function wrapper(root: ReactTestInstance) {
  return root.findAll(
    node => Object.is(node.type, 'View') && node.props.className === 'relative'
  )[0];
}

/** Fire the layout pass that triggers the one reveal for the active row. */
function layout(node: ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onLayout as (() => void) | undefined)?.();
  });
}

describe('SettingsTarget', () => {
  it('returns the row untouched without an active target scope', () => {
    const root = mount(<SettingsTarget item={system}>{row('alone')}</SettingsTarget>);

    expect(root.findByProps({ testID: 'alone' })).toBeTruthy();
    expect(root.findAll(node => Object.is(node.type, 'View'))).toEqual([]);
    expect(overlays(root)).toEqual([]);
  });

  it('reveals and highlights the matching row once, without changing its node', () => {
    const root = mount(
      <SettingsSearchTargetScope
        settingsTarget="appearance.dark"
        scrollRef={scrollTarget(fake.scroll)}
      >
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchTargetScope>
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toHaveLength(1);
    const box = wrapper(root);
    expect(box?.props.accessibilityRole).toBeUndefined();
    expect(box?.props.accessible).toBeUndefined();

    layout(box);
    // A later layout pass must not scroll the screen back to the row.
    layout(box);
    expect(fake.scroll.scrollTo).toHaveBeenCalledTimes(1);
    expect(fake.scroll.scrollTo).toHaveBeenCalledWith({ y: 28, animated: true });
  });

  it('leaves a non-matching row and its group geometry alone', () => {
    const root = mount(
      <SettingsSearchTargetScope
        settingsTarget="appearance.system"
        scrollRef={scrollTarget(fake.scroll)}
      >
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchTargetScope>
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toEqual([]);
    expect(root.findAll(node => Object.is(node.type, 'View'))).toEqual([]);
    expect(fake.scroll.scrollTo).not.toHaveBeenCalled();
  });

  it('matches an alias id for a control shared by several definitions', () => {
    const root = mount(
      <SettingsSearchTargetScope
        settingsTarget="appearance.dark"
        scrollRef={scrollTarget(fake.scroll)}
      >
        <SettingsTarget item={system} targetIds={['appearance.dark', 'appearance.light']}>
          {row()}
        </SettingsTarget>
      </SettingsSearchTargetScope>
    );

    expect(overlays(root)).toHaveLength(1);
  });
});

describe('SettingsSearchScrollView', () => {
  it('forwards tab-scroll props and the scroll ref while supplying the target', () => {
    const forwarded = scrollTarget(null);
    const root = mount(
      <SettingsSearchScrollView
        settingsTarget="appearance.dark"
        ref={forwarded}
        contentContainerClassName="gap-6 px-4 pt-3"
        keyboardShouldPersistTaps="handled"
      >
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    const scroller = root.findByType('TabScroll');
    expect(scroller.props.contentContainerClassName).toBe('gap-6 px-4 pt-3');
    expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
    expect(forwarded.current).toBe(fake.scroll);
    expect(overlays(root)).toHaveLength(1);

    layout(wrapper(root));
    expect(fake.scroll.scrollTo).toHaveBeenCalledWith({ y: 28, animated: true });
  });

  it('renders the plain body when the route names no target', () => {
    const root = mount(
      <SettingsSearchScrollView contentContainerClassName="gap-6">
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toEqual([]);
  });
});
