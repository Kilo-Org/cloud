// The mount and press scaffolding of the option screen's hardware Back suite.
// The suite keeps its own `vi.hoisted` state and `vi.mock` registrations —
// those are hoisted and order-sensitive — so the one helper that asserts on
// that state, `dismissedScreen`, takes the suite's router mock as an argument.

import { createElement } from 'react';

import { expect, type Mock } from 'vitest';

import { LeaveSettleMount } from '@/lib/navigation/leave-settle-mount';
import { act, TestRenderer } from '@/test/renderer';

import { OptionList } from './option-list';

const OPTIONS = ['off', 'all'] as const;

type SelectFn = (value: 'off' | 'all') => Promise<unknown>;
type RowProps = { label: string; busy: boolean; disabled: boolean; onPress: () => void };

/**
 * The app shell's listener is its own root, mounted first and left mounted:
 * only the screen's route goes away, the shell does not.
 */
export async function mount(onSelect: SelectFn): Promise<TestRenderer.ReactTestRenderer> {
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
  if (!screen.current) {
    // act guarantees the ref is set; the throw keeps the return type honest
    // without a non-null assertion the linter would have to forgive.
    throw new Error('option list did not mount');
  }
  return screen.current;
}

export function row(renderer: TestRenderer.ReactTestRenderer, label: string): RowProps {
  const found = renderer.root
    .findAll(node => String(node.type) === 'View' && node.props.label === label)
    .map(node => node.props as RowProps)[0];
  if (!found) {
    throw new Error(`row ${label} not found`);
  }
  return found;
}

/** The row's press handler returns void; the busy state settles a turn later. */
export async function press(rowProps: RowProps): Promise<void> {
  await act(async () => {
    rowProps.onPress();
    await Promise.resolve();
  });
}

/** Confirm the save, which runs the screen's own dismissal. */
export async function settleSave(gate: PromiseWithResolvers<boolean>): Promise<void> {
  await act(async () => {
    gate.resolve(true);
    await Promise.resolve();
  });
}

/**
 * A screen whose save confirmed and left the tree: its dismissal ran once and
 * only the leave window it opened is left behind.
 */
export async function dismissedScreen(routerBack: Mock): Promise<void> {
  const gate = Promise.withResolvers<boolean>();
  const renderer = await mount(() => gate.promise);
  await press(row(renderer, 'All'));
  await settleSave(gate);
  expect(routerBack).toHaveBeenCalledTimes(1);
  act(() => {
    renderer.unmount();
  });
}
