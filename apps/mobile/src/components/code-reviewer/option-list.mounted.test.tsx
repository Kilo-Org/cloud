// Failed-save contract: a rejected `onSelect` keeps the screen mounted (no
// router.back), clears the row's busy state, and renders an inline localized
// error with a Retry action that resubmits the failed option. Retry success
// pops the screen; a selection while an error shows clears the error.
// Save-completion contract: the pop runs only while this screen is still the
// focused route, so a Back pressed during the save pops exactly once.

/* eslint-disable promise-function-async -- gate fakes must stay pending until the test releases them */

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { OptionList } from './option-list';

vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack }),
  useNavigation: () => ({ isFocused: () => focus.focused }),
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { accessibilityLabel?: string; onPress?: () => void; children?: ReactNode }) =>
    createElement(
      'View',
      { accessibilityLabel: props.accessibilityLabel, onPress: props.onPress },
      props.children
    ),
}));
vi.mock('@/components/ui/choice-row', () => ({
  ChoiceRow: (props: {
    label: string;
    selected: boolean;
    busy: boolean;
    disabled: boolean;
    onPress: () => void;
  }) => createElement('View', props),
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

const routerBack = vi.hoisted(() => vi.fn());
// Route focus as the navigator reports it: `false` once this screen is gone.
const focus = vi.hoisted(() => ({ focused: true }));

const OPTIONS = ['off', 'all'] as const;

type SelectFn = (value: 'off' | 'all') => Promise<unknown>;
// The OptionList prop type widens the value to `string` in its own generic bound;
// the mock keeps the literal union, so the element cast narrows it back.

async function mountAsync(onSelect: SelectFn): Promise<TestRenderer.ReactTestRenderer> {
  const ref = { current: undefined as TestRenderer.ReactTestRenderer | undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
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
  return ref.current!;
}

type RowProps = {
  label: string;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
};

function rows(root: TestRenderer.ReactTestRenderer): RowProps[] {
  return root.root
    .findAll(node => String(node.type) === 'View' && node.props.label != null)
    .map(node => node.props as RowProps);
}

function row(root: TestRenderer.ReactTestRenderer, label: string): RowProps {
  const found = rows(root).find(props => props.label === label);
  if (!found) {
    throw new Error(`row ${label} not found`);
  }
  return found;
}

function texts(root: TestRenderer.ReactTestRenderer): string[] {
  return root.root
    .findAll(node => String(node.type) === 'Text' && node.props.children != null)
    .flatMap(node =>
      Array.isArray(node.props.children) ? node.props.children : [node.props.children]
    )
    .filter((child): child is string => typeof child === 'string');
}

/** The OptionList press handler returns void; the state updates settle over a few microtask turns. */
async function press(pressable: () => void): Promise<void> {
  await act(async () => {
    pressable();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  routerBack.mockReset();
  focus.focused = true;
});

describe('OptionList failed save', () => {
  it('keeps the screen mounted with the previous value and no busy state on a rejected save', async () => {
    const renderer = await mountAsync(() => {
      throw new Error('failed');
    });
    await press(() => {
      row(renderer, 'All').onPress();
    });

    expect(routerBack).not.toHaveBeenCalled();
    expect(row(renderer, 'All').busy).toBe(false);
    expect(row(renderer, 'All').selected).toBe(false);
    expect(row(renderer, 'Off').selected).toBe(true);
    expect(row(renderer, 'All').disabled).toBe(false);
  });

  it('renders the inline localized error and Retry that resubmits the failed option', async () => {
    const onSelect = vi
      .fn<SelectFn>()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce(undefined);
    const renderer = await mountAsync(onSelect);
    await press(() => {
      row(renderer, 'All').onPress();
    });

    expect(texts(renderer)).toContain(i18n.t('codeReviewer.configSaveFailed'));

    const retry = renderer.root.findAllByProps({
      accessibilityLabel: i18n.t('common.retry'),
    })[0];
    if (!retry) {
      throw new Error('retry button not found');
    }
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenLastCalledWith('all');
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  it('clears the inline error while the next save is in flight', async () => {
    const gate = Promise.withResolvers<boolean>();
    const onSelect = vi
      .fn<SelectFn>()
      .mockRejectedValueOnce(new Error('failed'))
      .mockReturnValueOnce(gate.promise);
    const renderer = await mountAsync(onSelect);
    await press(() => {
      row(renderer, 'All').onPress();
    });
    expect(texts(renderer)).toContain(i18n.t('codeReviewer.configSaveFailed'));

    await press(() => {
      row(renderer, 'Off').onPress();
    });

    expect(texts(renderer)).not.toContain(i18n.t('codeReviewer.configSaveFailed'));
    expect(row(renderer, 'Off').busy).toBe(true);
    expect(routerBack).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve(true);
      await Promise.resolve();
    });
    expect(routerBack).toHaveBeenCalledTimes(1);
  });

  it('pops the screen only after the save resolves', async () => {
    const gate = Promise.withResolvers<boolean>();
    const renderer = await mountAsync(() => gate.promise);
    await act(async () => {
      row(renderer, 'All').onPress();
      await Promise.resolve();
    });

    expect(routerBack).not.toHaveBeenCalled();
    expect(row(renderer, 'All').busy).toBe(true);

    await act(async () => {
      gate.resolve(true);
      await Promise.resolve();
    });
    expect(routerBack).toHaveBeenCalledTimes(1);
  });
});

describe('OptionList save that outlives the screen', () => {
  it('leaves the screen beneath alone when the save resolves after the user left', async () => {
    const gate = Promise.withResolvers<boolean>();
    const onSelect = vi.fn<SelectFn>().mockReturnValue(gate.promise);
    const renderer = await mountAsync(onSelect);
    await act(async () => {
      row(renderer, 'All').onPress();
      await Promise.resolve();
    });
    expect(row(renderer, 'All').busy).toBe(true);

    // Back while the PATCH is in flight: the navigator already removed this
    // screen, so it reports itself unfocused by the time the save resolves.
    focus.focused = false;
    await act(async () => {
      gate.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledWith('all');
    expect(routerBack).not.toHaveBeenCalled();
  });
});
