// A native sheet covers the app's main view tree on both platforms, so a toast
// the root Toaster draws while a sheet is open stays out of sight until the
// sheet closes (the save-as-to-do failure, the MCP settings and language picker
// failures). The app's one Toaster must render inside the open sheet instead —
// the imperative `Sheet` and a focused formSheet scene both host it — and hand
// the toasts back when the sheet goes.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import { AppToaster } from '@/components/app-toaster';
import { appSceneLayout } from '@/components/app-screen-layout';
import { type ScreenLayoutProps } from '@/components/centered-state-surface';
import { Sheet } from '@/components/ui/sheet';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'ios' },
  View: 'View',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/components/ui/icons', () => ({
  CheckCircle2: 'Icon',
  Info: 'Icon',
  Loader: 'Icon',
  TriangleAlert: 'Icon',
  XCircle: 'Icon',
}));
vi.mock('expo-router', () => ({ usePathname: () => '/agents', useSegments: () => ['(app)'] }));
// The formSheet scene's covered-scene gate is under test, not the unlock
// surface the layout module also builds for the root scenes.
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: ReactNode }) => children,
}));
// The measured surface reports native observation failures to Sentry, whose
// React Native SDK cannot load in Node.
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

afterEach(() => {
  view?.unmount();
  view = null;
  toastStore.clear();
});

/** The app root: the screen, then the Toaster the root providers mount last. */
function appRoot(screen: ReactElement) {
  return createElement('AppRoot', null, screen, createElement(AppToaster));
}

async function mount(screen: ReactElement) {
  view = await renderWithProviders(appRoot(screen));
  return view;
}

/** Updates the screen in place; the provider root must stay the same element. */
function rerender(screen: ReactElement) {
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

function raise(title: string) {
  act(() => {
    toast.error(title);
  });
}

function hostsOfType(type: string): ReactTestInstance[] {
  return view?.renderer.root.findAll(node => (node.type as string) === type) ?? [];
}

/** The host element that draws `title`. Exactly one Toaster draws it. */
function toastText(title: string): ReactTestInstance {
  const matches = hostsOfType('Text').filter(node => node.children.includes(title));
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) {
    throw new Error(`No toast reads "${title}"`);
  }
  return match;
}

function ancestors(node: ReactTestInstance): string[] {
  const types: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (typeof parent.type === 'string') {
      types.push(parent.type);
    }
  }
  return types;
}

function sheet(visible: boolean, content: ReactNode = createElement('SheetBody')) {
  return (
    <Sheet visible={visible} onClose={() => undefined}>
      {content}
    </Sheet>
  );
}

it('draws a toast raised while an imperative sheet is open inside that sheet', async () => {
  await mount(createElement('Screen', null, sheet(true)));

  raise('Couldn’t load MCP servers');

  expect(ancestors(toastText('Couldn’t load MCP servers'))).toContain('BottomSheet');
  // The root Toaster steps aside: one Toaster draws the toasts.
  expect(hostsOfType('Toaster')).toHaveLength(1);
});

it('hands the toasts back to the app tree once the sheet starts to close', async () => {
  await mount(createElement('Screen', null, sheet(true)));
  raise('Saved');
  expect(ancestors(toastText('Saved'))).toContain('BottomSheet');

  // The sheet stays mounted until the native dismissal reports; the toast must
  // not leave with it.
  rerender(createElement('Screen', null, sheet(false)));

  expect(hostsOfType('BottomSheet')).toHaveLength(1);
  expect(ancestors(toastText('Saved'))).not.toContain('BottomSheet');
});

it('draws in the top sheet when a sheet opens over another', async () => {
  await mount(createElement('Screen', null, sheet(true, sheet(true, createElement('Inner')))));

  raise('Couldn’t change the language');

  const inner = ancestors(toastText('Couldn’t change the language'));
  expect(inner.filter(type => type === 'BottomSheet')).toHaveLength(2);
});

/** A route scene as the native Stack hands it to the scene layout. */
function routeScene(
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

it.each(['formSheet', 'modal'])(
  'draws a toast raised from a focused %s route inside its scene',
  async presentation => {
    const focused = { current: true };
    const listeners = new Map<string, () => void>();
    await mount(routeScene(presentation, focused, listeners));

    raise('Couldn’t load that language');

    expect(ancestors(toastText('Couldn’t load that language'))).toContain('Scene');

    // A blurred scene — covered or dismissing — hands the toasts back.
    act(() => {
      focused.current = false;
      listeners.get('blur')?.();
    });
    expect(ancestors(toastText('Couldn’t load that language'))).not.toContain('Scene');
  }
);

it('keeps the toasts in the app tree for a card screen', async () => {
  await mount(routeScene('card', { current: true }, new Map()));

  raise('Link copied');

  expect(ancestors(toastText('Link copied'))).not.toContain('Scene');
});
