// On Android a native sheet covers the app's main view tree, so a toast the
// root Toaster draws while a sheet is open stays out of sight until the sheet
// closes (the save-as-to-do failure, the MCP settings failures). There the
// app's one Toaster must render inside the open sheet — the imperative `Sheet`
// and a focused presented route both host it — below the sheet's header, clear
// of its actions, and hand the toasts back when the sheet goes. On iOS the root
// Toaster's window-level overlay already draws above every sheet, so it stays
// exactly where it is.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode, useRef } from 'react';
import { type ViewInstance } from 'react-native';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import { AppToaster } from '@/components/app-toaster';
import { appSceneLayout } from '@/components/app-screen-layout';
import { type ScreenLayoutProps } from '@/components/centered-state-surface';
import { useSheetToastHeader } from '@/components/sheet-toast-host';
import { Sheet } from '@/components/ui/sheet';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: platform,
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

beforeEach(() => {
  platform.OS = 'android';
});

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

function theToaster(): ReactTestInstance {
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
function toastText(title: string): ReactTestInstance {
  const matches = hostsOfType('Text').filter(node => node.children.includes(title));
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) {
    throw new Error(`No toast reads "${title}"`);
  }
  return match;
}

function hostAncestors(node: ReactTestInstance): ReactTestInstance[] {
  const hosts: ReactTestInstance[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (typeof parent.type === 'string') {
      hosts.push(parent);
    }
  }
  return hosts;
}

function ancestors(node: ReactTestInstance): string[] {
  return hostAncestors(node).map(host => host.type as string);
}

function sheet(visible: boolean, content: ReactNode = createElement('SheetBody')) {
  return (
    <Sheet visible={visible} onClose={() => undefined}>
      {content}
    </Sheet>
  );
}

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

it('draws a toast raised while an Android sheet is open at the top of that sheet', async () => {
  await mount(createElement('Screen', null, sheet(true)));

  raise('Couldn’t load MCP servers');

  expect(ancestors(toastText('Couldn’t load MCP servers'))).toContain('BottomSheet');
  expect(theToaster().props).toMatchObject({
    position: 'top-center',
    fullWindowOverlay: false,
    // The container spans from the toast down, so the toast is inside its
    // parent's rect and stays in the accessibility tree.
    positionerStyle: { bottom: 0 },
  });
  // Touches outside the toast's own box reach the sheet: the nearest view
  // around the Toaster is the anchor over the sheet's frame.
  const [anchor] = hostAncestors(theToaster());
  expect(anchor?.props.pointerEvents).toBe('box-none');
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
  expect(theToaster().props.position).toBe('bottom-center');
});

it('draws in the top sheet when a sheet opens over another', async () => {
  await mount(createElement('Screen', null, sheet(true, sheet(true, createElement('Inner')))));

  raise('That URL is already saved.');

  const inner = ancestors(toastText('That URL is already saved.'));
  expect(inner.filter(type => type === 'BottomSheet')).toHaveLength(2);
});

it.each(['formSheet', 'modal'])(
  'draws a toast raised from a focused Android %s route inside its scene',
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

it('keeps the root Toaster on iOS while sheets and route sheets are open', async () => {
  platform.OS = 'ios';
  await mount(
    createElement(
      'Screen',
      null,
      sheet(true, sheet(true)),
      routeScene('formSheet', { current: true }, new Map())
    )
  );

  raise('Couldn’t load MCP servers');

  const placement = ancestors(toastText('Couldn’t load MCP servers'));
  expect(placement).not.toContain('BottomSheet');
  expect(placement).not.toContain('Scene');
  // Main's root Toaster, unchanged: bottom, window-level overlay, the
  // accessibility anchor, sonner's own padding.
  expect(theToaster().props).toMatchObject({
    position: 'bottom-center',
    fullWindowOverlay: true,
    positionerStyle: { top: 0 },
  });
  const toastOptions = theToaster().props.toastOptions as { style: { paddingVertical?: number } };
  expect(toastOptions.style.paddingVertical).toBeUndefined();
});

/**
 * The "Discard changes?" confirm's geometry, from its own classes: the header,
 * then `SCREEN_BODY_CLASS` (10.5dp top pad, 21dp gap) around a one-line muted
 * message (`text-sm`, a 17.5dp line) and the Discard button. The header's
 * bottom is whatever the device measures (about 73.5dp: 14dp top pad, the
 * 48dp row, 10.5dp bottom pad and the divider); the clearance below it does
 * not depend on it.
 */
const CONFIRM = { headerBottom: 73.5, bodyTopPad: 10.5, messageLine: 17.5, sectionGap: 21 };
/** sonner-native's title line height. */
const SONNER_TITLE_LINE = 20;

/** A `SheetHeader` stand-in that reports the measured frame the device gives it. */
function MeasuredHeader({ bottom }: Readonly<{ bottom: number }>) {
  const ref = useRef({
    measureLayout: (_relativeTo: unknown, onSuccess: (...frame: number[]) => void) => {
      // left, top, width, height of the header inside the sheet's frame
      onSuccess(0, 0, 400, bottom);
    },
  } as unknown as ViewInstance);
  useSheetToastHeader(ref);
  return createElement('SheetHeader');
}

it('keeps a short sheet’s bottom actions clear of the toast on Android', async () => {
  await mount(
    createElement(
      'Screen',
      null,
      sheet(
        true,
        <>
          <MeasuredHeader bottom={CONFIRM.headerBottom} />
          {createElement('Message')}
          {createElement('DiscardButton')}
        </>
      )
    )
  );

  raise('That URL is already saved.');

  const { offset, toastOptions } = theToaster().props as {
    offset: number;
    toastOptions: { style: { paddingVertical: number; borderWidth: number } };
  };
  // The toast starts below the header, so the header's own actions stay above it.
  expect(offset).toBeGreaterThan(CONFIRM.headerBottom);
  const toastBottom =
    offset +
    SONNER_TITLE_LINE +
    2 * toastOptions.style.paddingVertical +
    2 * toastOptions.style.borderWidth;
  const discardTop =
    CONFIRM.headerBottom + CONFIRM.bodyTopPad + CONFIRM.messageLine + CONFIRM.sectionGap;
  expect(toastBottom).toBeLessThan(discardTop);
});
