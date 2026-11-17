// The Security Agent settings header Save action is a variable-width header
// action. ScreenHeader clamps the trailing slot to half the row and lets the
// title shrink, but the Button's own base is `shrink-0`, so a label that grows
// with its copy keeps its width: the catalog "Save changes" is 28 glyphs in
// French, and an uncapped button consumed the row and left the flex-1 min-w-0
// screen title at ~0 width on the narrowest 320 dp viewport. The action must
// bound itself at its source, exactly like PR review's Submit review.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsSaveButton } from './settings-save-button';
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';

const routerState = vi.hoisted(() => ({ back: vi.fn() }));

// The vendored context is a plain `createContext(undefined)` in expo-router.
// Mocking it with a context of this suite's own keeps a Node test off the build
// file and lets the settle-time focus read be driven from the provider value
// (same pattern as `picker-sheet.focus.mounted.test.tsx`). The factory is
// hoisted above the imports, so React is only reachable through a dynamic
// import here. Suites that never provide a value keep the no-navigator
// degradation.
vi.mock('expo-router/build/react-navigation/core/NavigationContext', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext<unknown>(undefined) };
});

vi.mock('expo-router', () => ({ useRouter: () => routerState }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2' }));
vi.mock('@/lib/a11y/motion', () => ({ useMotionPolicy: () => ({ reducedMotion: false }) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useMutedDisabledInk: () => '#fff',
  useThemeColors: () => ({ primaryForeground: '#fff', foreground: '#000' }),
}));
// Keep the real Button (its shrink-0 base and the `cn` merge are what this
// contract is about) and stub only the Text primitive, which needs a slot
// package that does not load under the DOM-free renderer.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return {
    Text: 'Text',
    TextClassContext: createContext<string | undefined>(undefined),
  };
});

type Instance = TestRenderer.ReactTestInstance;

type FocusState = { focused: boolean };

/**
 * Mount with the vendored NavigationContext provided. The provider reads
 * `focusState` at call time, so a test can blur the route after the last
 * render and before the save settles — the race the button's settle-time
 * focus read exists for.
 */
function renderWithNavigation(
  focusState: FocusState,
  props: Partial<Parameters<typeof SettingsSaveButton>[0]> = {}
) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(
        NavigationContext.Provider,
        {
          value: {
            isFocused: () => focusState.focused,
            addListener: () => () => undefined,
            // A state-only fake navigation object: the app's focus hook reads
            // `isFocused` through the vendored context, and the provider's
            // declared value is the full navigator prop, so the partial object
            // goes in through `unknown`.
          } as unknown as Parameters<typeof NavigationContext.Provider>[0]['value'],
        },
        createElement(SettingsSaveButton, {
          dirty: true,
          valid: true,
          pending: false,
          onSave: vi.fn().mockResolvedValue(undefined),
          skipNextGuardRef: { current: false },
          ...props,
        })
      )
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function pressSave(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    (findSavePressable(renderer).props.onPress as () => void)();
  });
}

async function flushSave(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function render(props: Partial<Parameters<typeof SettingsSaveButton>[0]> = {}) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SettingsSaveButton, {
        dirty: true,
        valid: true,
        pending: false,
        onSave: vi.fn().mockResolvedValue(undefined),
        skipNextGuardRef: { current: false },
        ...props,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function classes(node: Instance): string[] {
  return String(node.props.className ?? '')
    .split(/\s+/u)
    .filter(Boolean);
}

function findSavePressable(renderer: TestRenderer.ReactTestRenderer): Instance {
  return renderer.root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
  );
}

function findLabel(renderer: TestRenderer.ReactTestRenderer): Instance {
  return renderer.root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'Text'
  );
}

// The spinner's ink has to match the surface it is drawn on; reading it through
// a guard keeps a missing indicator failing loudly.
function spinnerColor(renderer: TestRenderer.ReactTestRenderer): unknown {
  const spinner = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ActivityIndicator'
  )[0];
  if (spinner === undefined) {
    throw new Error('spinner was not rendered');
  }
  const { props } = spinner;
  if (!('color' in props)) {
    return undefined;
  }
  const color: unknown = props.color;
  return color;
}

describe('SettingsSaveButton header cap', () => {
  beforeEach(() => {
    routerState.back.mockReset();
  });

  it('bounds the trailing action so the flex-1 screen title keeps room to draw', () => {
    const button = findSavePressable(render());

    const tokens = classes(button);
    // A variable-width header action caps itself on the narrowest viewport.
    expect(tokens).toContain('max-w-[140px]');
    expect(tokens).toContain('min-w-0');
    // The Button's own `shrink-0` must be overridden or the cap would clip the
    // label instead of letting it compress.
    expect(tokens).toContain('shrink');
    expect(tokens).not.toContain('shrink-0');
  });

  it('lets the label compress and wrap inside the cap instead of clipping', () => {
    const label = findLabel(render());

    expect(classes(label)).toContain('shrink');
    // No line limit: the label wraps in place rather than ellipsizing, so a
    // long catalog translation stays readable.
    expect(label.props.numberOfLines).toBeUndefined();
  });

  it('only carries the filled primary style once there is a change to save', () => {
    // A clean screen has nothing to save: the header action stays a quiet text
    // control so it does not outshout the content's own way out.
    const clean = classes(findSavePressable(render({ dirty: false })));
    expect(clean).toContain('active:opacity-60');
    expect(clean).not.toContain('bg-primary');

    // An edit that is not valid yet cannot be saved either.
    const invalid = classes(findSavePressable(render({ dirty: true, valid: false })));
    expect(invalid).not.toContain('bg-primary');

    // A pending change is the one state that earns the fill.
    const pending = classes(findSavePressable(render({ dirty: true, valid: true })));
    expect(pending).toContain('bg-primary');
  });

  it('keeps the pending spinner ink on the surface it sits in', () => {
    // A save in flight whose draft turned invalid drops the header back to the
    // quiet style, so the spinner must switch to the body foreground instead of
    // the filled variant's white.
    expect(spinnerColor(render({ dirty: true, valid: true, pending: true }))).toBe('#fff');
    expect(spinnerColor(render({ dirty: true, valid: false, pending: true }))).toBe('#000');
  });

  it('still saves and pops the screen when the button is pressed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const renderer = render({ onSave });

    act(() => {
      (findSavePressable(renderer).props.onPress as () => void)();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledOnce();
    expect(routerState.back).toHaveBeenCalledOnce();
  });
});

describe('SettingsSaveButton current save', () => {
  beforeEach(() => {
    routerState.back.mockReset();
  });

  it('does not pop after the screen unmounted while the save was in flight', async () => {
    // The discard path of the screen's back guard pops the settings screen
    // while its save mutation is still running; the save that then settles
    // must not pop whatever route the user landed on.
    const { promise: savePromise, resolve: settleSave } = Promise.withResolvers<undefined>();
    const onSave = vi.fn().mockImplementation(() => savePromise);
    const skipNextGuardRef = { current: false };
    const renderer = render({ onSave, skipNextGuardRef });

    pressSave(renderer);
    act(() => {
      renderer.unmount();
    });
    settleSave();
    await flushSave();

    expect(onSave).toHaveBeenCalledOnce();
    expect(routerState.back).not.toHaveBeenCalled();
    // A skip flag armed without its navigation would swallow the next genuine
    // back confirmation on the screen that is on top now.
    expect(skipNextGuardRef.current).toBe(false);
  });

  it('does not pop after the route blurred while the save was in flight', async () => {
    // A screen replaced over this one blurs the route without unmounting it;
    // the focus read must happen when the save settles, not from the render.
    const focusState = { focused: true };
    const { promise: savePromise, resolve: settleSave } = Promise.withResolvers<undefined>();
    const onSave = vi.fn().mockImplementation(() => savePromise);
    const renderer = renderWithNavigation(focusState, { onSave });

    pressSave(renderer);
    focusState.focused = false;
    settleSave();
    await flushSave();

    expect(onSave).toHaveBeenCalledOnce();
    expect(routerState.back).not.toHaveBeenCalled();
  });

  it('pops while the route is focused', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const renderer = renderWithNavigation({ focused: true }, { onSave });

    pressSave(renderer);
    await flushSave();

    expect(onSave).toHaveBeenCalledOnce();
    expect(routerState.back).toHaveBeenCalledOnce();
  });

  it('starts only one save when two presses land before the pending re-render', async () => {
    // The mutation's `pending` prop only becomes true on a later render; both
    // presses here see `pending: false`. The synchronous claim must admit the
    // first and refuse the second.
    const { promise: savePromise, resolve: settleSave } = Promise.withResolvers<undefined>();
    const onSave = vi.fn().mockImplementation(() => savePromise);
    const renderer = render({ onSave });

    pressSave(renderer);
    pressSave(renderer);
    settleSave();
    await flushSave();

    expect(onSave).toHaveBeenCalledOnce();
    expect(routerState.back).toHaveBeenCalledOnce();
  });

  it('lets a retry start after a refused save cleared the claim', async () => {
    const refused = vi.fn().mockRejectedValue(new Error('refused'));
    const renderer = render({ onSave: refused });

    pressSave(renderer);
    // The rejection walks the awaited chain: catch and finally each take a
    // tick before the claim clears.
    await flushSave();
    await flushSave();
    await flushSave();
    expect(refused).toHaveBeenCalledOnce();
    expect(routerState.back).not.toHaveBeenCalled();

    // The retry is a second instance of the same save: it must be admitted.
    const retry = vi.fn().mockResolvedValue(undefined);
    act(() => {
      renderer.update(
        createElement(SettingsSaveButton, {
          dirty: true,
          valid: true,
          pending: false,
          onSave: retry,
          skipNextGuardRef: { current: false },
        })
      );
    });
    pressSave(renderer);
    await flushSave();

    expect(retry).toHaveBeenCalledOnce();
    expect(routerState.back).toHaveBeenCalledOnce();
  });
});
