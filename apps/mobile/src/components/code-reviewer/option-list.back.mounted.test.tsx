// Hardware Back contract of an option screen whose save is in flight. The save
// dismisses the screen once it confirms, and Android Back is the reader leaving
// the same screen; whichever order they happen in, one Back closes one screen.
//
// Two windows cover the pair. While this screen is still mounted it answers the
// Back itself; after the navigator removed the route — the exit animation's
// remainder — the app-level settle listener answers it, because a screen-level
// listener no longer exists to do so.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetLeaveSettle } from '@/lib/navigation/leave-settle';
import { LeaveSettleMount } from '@/lib/navigation/leave-settle-mount';
import { OptionList } from './option-list';

// Models React Native's BackHandler as a set of live subscriptions, so a test
// can press Android Back and observe what the mounted listeners do with it.
const backPress = vi.hoisted(() => {
  const listeners = new Set<() => boolean>();
  return {
    listeners,
    addEventListener: (_event: string, listener: () => boolean) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    // RN asks the most recently added listener first and stops at the first one
    // that consumes the press.
    press: () => [...listeners].toReversed().some(listener => listener()),
  };
});
const routerBack = vi.hoisted(() => vi.fn());
// Route focus as the navigator reports it.
const focus = vi.hoisted(() => ({ focused: true }));

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (event: string, listener: () => boolean) =>
      backPress.addEventListener(event, listener),
  },
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack }),
  useNavigation: () => ({ isFocused: () => focus.focused }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({
  ChoiceRow: (props: { label: string; busy: boolean; disabled: boolean; onPress: () => void }) =>
    createElement('View', props),
}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: ({ children }: { children?: ReactNode }): ReactNode => children,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: ({ children }: { children?: ReactNode }): ReactNode => children,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

const OPTIONS = ['off', 'all'] as const;

type SelectFn = (value: 'off' | 'all') => Promise<unknown>;
type RowProps = { label: string; busy: boolean; disabled: boolean; onPress: () => void };

// The dismissal records the window against the clock, so the test drives the
// clock instead of waiting for it.
let now = 1_000;

/**
 * The app shell's listener is its own root, mounted first and left mounted:
 * only the screen's route goes away, the shell does not.
 */
async function mount(onSelect: SelectFn): Promise<TestRenderer.ReactTestRenderer> {
  const shell = { current: undefined as TestRenderer.ReactTestRenderer | undefined };
  const screen = { current: undefined as TestRenderer.ReactTestRenderer | undefined };
  await act(async () => {
    shell.current = TestRenderer.create(createElement(LeaveSettleMount));
    screen.current = TestRenderer.create(
      createElement(OptionList, {
        title: 'Gate',
        options: OPTIONS,
        selected: 'off',
        onSelect: onSelect as (value: string) => Promise<unknown>,
        labels: { off: 'Off', all: 'All' },
        disabled: false,
      })
    );
    await Promise.resolve();
  });
  // oxlint-disable-next-line typescript-eslint/no-non-null-assertion -- act guarantees the ref is set; the linter's own preference cycle (assertion vs optional chain) makes a plain expression impossible
  return screen.current!;
}

function row(renderer: TestRenderer.ReactTestRenderer, label: string): RowProps {
  const found = renderer.root
    .findAll(node => String(node.type) === 'View' && node.props.label === label)
    .map(node => node.props as RowProps)[0];
  if (!found) {
    throw new Error(`row ${label} not found`);
  }
  return found;
}

/** The row's press handler returns void; the busy state settles a turn later. */
async function press(rowProps: RowProps): Promise<void> {
  await act(async () => {
    rowProps.onPress();
    await Promise.resolve();
  });
}

/** Confirm the save, which runs the screen's own dismissal. */
async function settleSave(gate: PromiseWithResolvers<boolean>): Promise<void> {
  await act(async () => {
    gate.resolve(true);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  now = 1_000;
  resetLeaveSettle();
  backPress.listeners.clear();
  routerBack.mockReset();
  focus.focused = true;
});

describe('OptionList hardware Back during a save', () => {
  it('does not pop the screen beneath when the save confirms after Back left this screen', async () => {
    const gate = Promise.withResolvers<boolean>();
    const renderer = await mount(() => gate.promise);
    await press(row(renderer, 'All'));

    // The navigator pops this screen for the Back. The save is still running,
    // so the focus flip has not necessarily reached the route when it resolves.
    expect(backPress.press()).toBe(false);
    await settleSave(gate);

    expect(routerBack).not.toHaveBeenCalled();
  });

  it('consumes a Back that lands while the save’s own dismissal runs', async () => {
    const gate = Promise.withResolvers<boolean>();
    const renderer = await mount(() => gate.promise);
    await press(row(renderer, 'All'));
    await settleSave(gate);
    expect(routerBack).toHaveBeenCalledTimes(1);

    // The route is still mounted for the exit animation, so its own listener
    // answers the press and the screen beneath never receives it.
    expect(backPress.press()).toBe(true);
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  it('spends a Back that arrives after the dismissed route was removed', async () => {
    const gate = Promise.withResolvers<boolean>();
    const renderer = await mount(() => gate.promise);
    await press(row(renderer, 'All'));
    await settleSave(gate);
    expect(routerBack).toHaveBeenCalledTimes(1);

    // Android delivers the Back once the navigator already dropped the route —
    // the case the screen-level listener cannot see. Only the leftover exit
    // animation is between the reader and the screen beneath.
    act(() => {
      renderer.unmount();
    });
    now += 300;

    expect(backPress.press()).toBe(true);
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  it('lets a Back through once the dismissed screen has finished leaving', async () => {
    const gate = Promise.withResolvers<boolean>();
    const renderer = await mount(() => gate.promise);
    await press(row(renderer, 'All'));
    await settleSave(gate);
    act(() => {
      renderer.unmount();
    });

    now += 1_000;

    expect(backPress.press()).toBe(false);
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  it('leaves Back to the navigator while this screen never started leaving', async () => {
    const pending = Promise.withResolvers<boolean>();
    await mount(() => pending.promise);

    expect(backPress.press()).toBe(false);
    expect(routerBack).not.toHaveBeenCalled();
  });
});
