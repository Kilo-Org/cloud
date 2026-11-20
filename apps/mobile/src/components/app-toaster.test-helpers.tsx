// The mounted harness the app-toaster suites share: the real `AppToaster`,
// `Sheet`, `SheetHeader` and scene layout over a small sonner-native stand-in.
// Import it before any app module, so its module mocks are in place first.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { toast } from 'sonner-native';
import { expect, vi } from 'vitest';

import { AppToaster } from '@/components/app-toaster';
import { appSceneLayout } from '@/components/app-screen-layout';
import { type ScreenLayoutProps } from '@/components/centered-state-surface';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { act, type ReactTestInstance } from '@/test/renderer';

type Rect = Readonly<{ top: number; bottom: number }>;

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

/** The window rects the views report through `getBoundingClientRect`, by role. */
const frames = vi.hoisted(() => ({
  anchor: null as Readonly<{ top: number; bottom: number }> | null,
  header: null as Readonly<{ top: number; bottom: number }> | null,
}));

const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

/** What a suite sets: the platform, the views' window rects, the status bar. */
export const harness = { platform, frames, insets };

vi.mock('react-native', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so `react`
  // must be pulled in here.
  const React = await import('react');
  // A host view whose window rect is the one the test set for its role: the
  // toast's anchor fills the sheet, the header draws the divider.
  function View({ ref, ...props }: { ref?: React.Ref<unknown>; className?: string }) {
    React.useImperativeHandle(ref, () => ({
      getBoundingClientRect: (): Rect | null => {
        const className = props.className ?? '';
        if (className.includes('absolute inset-0')) {
          return frames.anchor;
        }
        return className.includes('border-b') ? frames.header : null;
      },
    }));
    return React.createElement('View', props);
  }
  return {
    ActivityIndicator: 'ActivityIndicator',
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    I18nManager: { isRTL: false },
    Platform: platform,
    Pressable: 'Pressable',
    View,
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => insets }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/form-sheet', () => ({
  useSheetHeaderTopClearance: () => 0,
  useSettledSheetHeaderTopClearance: () => ({ clearance: 0, onLayout: () => undefined }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/components/ui/icons', () => ({
  CheckCircle2: 'Icon',
  Info: 'Icon',
  Loader: 'Icon',
  Share: 'Icon',
  TriangleAlert: 'Icon',
  X: 'Icon',
  XCircle: 'Icon',
}));
vi.mock('expo-router', () => ({ usePathname: () => '/agents', useSegments: () => ['(app)'] }));
// The presented scene's covered-scene gate is under test, not the unlock
// surface the layout module also builds for the root scenes.
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: ReactNode }) => children,
}));
// The layout module's measured scene surface reports native observation
// failures to Sentry, whose React Native SDK cannot load in Node.
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

/**
 * sonner-native's contract, small: a toast goes into one store, and the
 * unnamed Toaster that is mounted draws every toast in it.
 */
const toastStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let titles: readonly string[] = [];
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    titles: () => titles,
    add: (title: string) => {
      titles = [...titles, title];
      for (const listener of listeners) {
        listener();
      }
    },
    clear: () => {
      titles = [];
    },
  };
});
vi.mock('sonner-native', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so `react`
  // must be pulled in here.
  const React = await import('react');
  function Toaster(props: Record<string, unknown>) {
    const titles = React.useSyncExternalStore(
      toastStore.subscribe,
      toastStore.titles,
      toastStore.titles
    );
    return React.createElement(
      'Toaster',
      props,
      titles.map(title => React.createElement('Text', { key: title }, title))
    );
  }
  return {
    Toaster,
    toast: {
      error: (title: string) => {
        toastStore.add(title);
      },
    },
  };
});

let view: RenderWithProvidersResult | null = null;

/** Android, no measured rects, no status bar: every suite's `beforeEach`. */
export function resetToasterHarness(): void {
  platform.OS = 'android';
  frames.anchor = null;
  frames.header = null;
  insets.top = 0;
}

/** Every suite's `afterEach`. */
export function unmountToasterHarness(): void {
  view?.unmount();
  view = null;
  toastStore.clear();
}

/** The app root: the screen, then the Toaster the root providers mount last. */
function appRoot(screen: ReactElement) {
  return createElement('AppRoot', null, screen, createElement(AppToaster));
}

export async function mount(screen: ReactElement): Promise<void> {
  view = await renderWithProviders(appRoot(screen));
}

/** Updates the screen in place; the provider root must stay the same element. */
export function rerender(screen: ReactElement): void {
  const current = view;
  if (!current) {
    throw new Error('Nothing is mounted');
  }
  act(() => {
    current.renderer.update(
      createElement(QueryClientProvider, { client: current.queryClient }, appRoot(screen))
    );
  });
}

export function raise(title: string): void {
  act(() => {
    toast.error(title);
  });
}

export function hostsOfType(type: string): ReactTestInstance[] {
  return view?.renderer.root.findAll(node => (node.type as string) === type) ?? [];
}

export function theToaster(): ReactTestInstance {
  const toasters = hostsOfType('Toaster');
  // The root Toaster steps aside while a sheet hosts: one Toaster draws.
  expect(toasters).toHaveLength(1);
  const [toaster] = toasters;
  if (!toaster) {
    throw new Error('No Toaster is mounted');
  }
  return toaster;
}

/** The host element that draws `title`. Exactly one Toaster draws it. */
export function toastText(title: string): ReactTestInstance {
  const matches = hostsOfType('Text').filter(node => node.children.includes(title));
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) {
    throw new Error(`No toast reads "${title}"`);
  }
  return match;
}

export function hostAncestors(node: ReactTestInstance): ReactTestInstance[] {
  const hosts: ReactTestInstance[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (typeof parent.type === 'string') {
      hosts.push(parent);
    }
  }
  return hosts;
}

export function ancestors(node: ReactTestInstance): string[] {
  return hostAncestors(node).map(host => host.type as string);
}

/** A route scene as the native Stack hands it to the scene layout. */
export function routeScene(
  presentation: string,
  focused: { current: boolean },
  listeners: Map<string, () => void>
) {
  const props = {
    navigation: {
      isFocused: () => focused.current,
      addListener: (event: string, listener: () => void) => {
        listeners.set(event, listener);
        return () => {
          listeners.delete(event);
        };
      },
      getState: () => ({ index: 0, routes: [{ key: 'language-picker' }] }),
    },
    options: { presentation },
    children: createElement('LanguagePicker'),
  };
  return createElement('Scene', null, appSceneLayout(props as unknown as ScreenLayoutProps));
}
