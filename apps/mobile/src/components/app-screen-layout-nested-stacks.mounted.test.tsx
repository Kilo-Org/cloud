import { createElement, type ElementType, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, expect, it, vi } from 'vitest';

import AuthLayout from '@/app/(auth)/_layout';
import ChatLayout from '@/app/(app)/(tabs)/(4_chat)/_layout';
import HomeLayout from '@/app/(app)/(tabs)/(0_home)/_layout';
import AgentsLayout from '@/app/(app)/(tabs)/(2_agents)/_layout';
import CodeReviewerEditLayout from '@/app/(app)/code-reviewer/[scope]/[platform]/(edit)/_layout';
import CodeReviewerPlatformLayout from '@/app/(app)/code-reviewer/[scope]/[platform]/_layout';
import SecurityAgentScopeLayout from '@/app/(app)/security-agent/[scope]/_layout';
import ProfileLayout from '@/app/(app)/(tabs)/(3_profile)/_layout';

// These stacks sit inside a root `(app)` scene that already hosts the unlock
// surface, so they install the gate alone; nothing here reads a provider. The
// gate module imports the unlock layout at module scope, so it is stubbed.
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/security-agent/security-agent-command-observer', () => ({
  SecurityAgentCommandObserver: 'SecurityAgentCommandObserver',
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: () => undefined,
}));
vi.mock('@/lib/hooks/use-reviewer-route-params', () => ({
  useValidatedReviewerRouteParams: () => ({ scope: 'personal', platform: 'github' }),
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({ useReviewerEditGuard: () => undefined }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: 'background' }),
}));
vi.mock('@/lib/form-sheet', () => ({
  useFormSheetScreenOptions: () => ({ sheetAllowedDetents: [0.5, 1] }),
}));
vi.mock('@/components/centered-state-surface', () => ({
  NativeStateSurface: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, View: 'View' }));

/**
 * One scene navigation object per navigator the fake Stack mounts, reporting
 * the position that stack gives the scene. Emitting the event is what a push of
 * a sibling route over the scene does.
 */
const scenes = vi.hoisted(() => {
  const made: {
    navigation: {
      isFocused: () => boolean;
      addListener: (event: string, listener: () => void) => () => void;
    };
    setFocused: (next: boolean) => void;
    listenerCount: () => number;
  }[] = [];
  function makeScene() {
    const listeners = new Map<string, Set<() => void>>();
    let focused = true;
    const scene = {
      navigation: {
        isFocused: () => focused,
        addListener: (event: string, listener: () => void) => {
          const registered = listeners.get(event) ?? new Set<() => void>();
          registered.add(listener);
          listeners.set(event, registered);
          return () => registered.delete(listener);
        },
      },
      setFocused(next: boolean) {
        focused = next;
        for (const listener of listeners.get(next ? 'focus' : 'blur') ?? []) {
          listener();
        }
      },
      listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    };
    made.push(scene);
    return scene.navigation;
  }
  return { made, makeScene };
});

vi.mock('expo-router', () => ({
  // The real Stack applies the layout it is given to each scene it keeps.
  Stack: Object.assign(
    ({ screenLayout }: { screenLayout: (props: unknown) => ReactElement }) =>
      createElement(
        'NestedNavigator',
        null,
        screenLayout({ navigation: scenes.makeScene(), children: createElement('SceneBody') })
      ),
    { Screen: ({ name }: { name: string }) => createElement('RegisteredScreen', { name }) }
  ),
  useLocalSearchParams: () => ({ scope: 'personal', platform: 'github' }),
  // The tab and section stacks settle their switch-input window on focus.
  useFocusEffect: () => undefined,
}));

type LayoutComponent = () => ReactElement;

const layouts: [string, LayoutComponent][] = [
  ['home', HomeLayout],
  ['agents', AgentsLayout],
  ['profile', ProfileLayout],
  ['chat', ChatLayout],
  ['code reviewer', CodeReviewerPlatformLayout],
  ['code reviewer edit', CodeReviewerEditLayout],
  ['security agent', SecurityAgentScopeLayout],
  ['sign-in', AuthLayout],
];

function gate(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node => (node.type as string) === 'View' && node.props.collapsable === false
  );
}

function mount(layout: LayoutComponent) {
  const mounted: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    mounted.current = TestRenderer.create(createElement(layout));
  });
  const renderer = mounted.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  return renderer;
}

beforeEach(() => {
  scenes.made.length = 0;
});

it.each(layouts)('hides a covered %s scene from screen readers', (_name, Layout) => {
  const renderer = mount(Layout);
  const scene = scenes.made[0];
  if (!scene) {
    throw new Error('the layout did not mount a scene');
  }
  expect(renderer.root.findByType('SceneBody' as ElementType)).toBeTruthy();
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
