import { createElement, type ElementType, type ReactElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, expect, it, vi } from 'vitest';

import OrganizationLayout from './_layout';

// The gate is the layout's own `screenLayout`; the unlock surface it wraps in
// production needs i18n, the native keychain and the unlock provider, none of
// which the gate reads, so the wrapper is replaced by its children here.
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/components/centered-state-surface', () => ({
  NativeStateSurface: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/lib/form-sheet', () => ({
  useFormSheetScreenOptions: () => ({ sheetAllowedDetents: [0.5, 1] }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ card: '#FFFFFF' }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  // Above the half-detent threshold, so the shared organization detents are
  // `[0.5, 1]` and only the invite sheet's own override can yield `[1]`; a
  // shorter window would pass that expectation without the override.
  useWindowDimensions: () => ({ width: 400, height: 900 }),
}));

/**
 * The scene's own navigation object: the nested Stack hands it to the layout,
 * not the parent navigator's, so the gate keyed on it reports this stack's
 * position. Emitting the event is what a push or sheet presentation does.
 */
const scene = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    addListener: (event: string, listener: () => void) => {
      const registered = listeners.get(event) ?? new Set<() => void>();
      registered.add(listener);
      listeners.set(event, registered);
      return () => registered.delete(listener);
    },
  };
  return {
    navigation,
    setFocused(next: boolean) {
      focused = next;
      const registered = listeners.get(next ? 'focus' : 'blur');
      if (registered) {
        for (const listener of registered) {
          listener();
        }
      }
    },
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
  };
});

vi.mock('expo-router', () => ({
  // The real Stack applies the layout it is given to the scene it mounts, and
  // keeps its registered screens as children it can match routes against.
  Stack: Object.assign(
    ({
      screenLayout,
      children,
    }: {
      screenLayout: (props: unknown) => ReactElement;
      children?: ReactNode;
    }) =>
      createElement(
        'NestedNavigator',
        null,
        screenLayout({ navigation: scene.navigation, children: createElement('SceneBody') }),
        children
      ),
    {
      Screen: ({ name, options }: { name: string; options?: ReactNode }) =>
        createElement('RegisteredScreen', { name, options }),
    }
  ),
}));

const SceneBody = 'SceneBody' as ElementType;

/** A key of a value as an unknown: the renderer types props as `any`. */
function member(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  // The `in` guard above proved the key exists; the record view keeps the read
  // checked and the callers narrow the value with their own assertions.
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return record[key];
}

function gate(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node => (node.type as string) === 'View' && node.props.collapsable === false
  );
}

beforeEach(() => {
  scene.setFocused(true);
});

it('hides the organization scene when a sheet covers it in the nested stack', () => {
  const mounted: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    mounted.current = TestRenderer.create(createElement(OrganizationLayout));
  });
  const renderer = mounted.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }

  expect(
    renderer.root.findByType('NestedNavigator' as ElementType).findByType(SceneBody)
  ).toBeTruthy();
  expect(gate(renderer).props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });

  act(() => {
    scene.setFocused(false);
  });
  expect(gate(renderer).props).toMatchObject({
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });

  act(() => {
    scene.setFocused(true);
  });
  expect(gate(renderer).props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });

  act(() => {
    renderer.unmount();
  });
  expect(scene.listenerCount()).toBe(0);
});

it('presents the invite member sheet at one full detent on Android so the keyboard cannot cover its fields', () => {
  const mounted: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    mounted.current = TestRenderer.create(createElement(OrganizationLayout));
  });
  const renderer = mounted.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  const navigator = renderer.root.findByType('NestedNavigator' as ElementType);
  const registered: TestRenderer.ReactTestInstance[] = navigator.findAllByType(
    'RegisteredScreen' as ElementType
  );
  const invite = registered.find(node => member(node.props, 'name') === 'invite-member');
  expect(invite).toBeDefined();
  const options = member(invite?.props, 'options');
  // The email field auto-focuses, so the keyboard opens over the half detent
  // and covers the field and the role list; the single full detent is the
  // keyboard-safe layout every other Android formSheet with a focused input
  // carries.
  expect(member(options, 'sheetAllowedDetents')).toEqual([1]);
  expect(member(options, 'gestureEnabled')).toBe(false);

  act(() => {
    renderer.unmount();
  });
});
