import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SessionListSearchHeader } from './session-list-search-header';
import {
  useSessionSearchInput,
  type UseSessionSearchInputParams,
  type UseSessionSearchInputResult,
} from './use-session-search-input';

const input = vi.hoisted(() => ({
  blurs: 0,
  clears: 0,
  mounts: [] as { defaultValue?: string }[],
}));

// The field is uncontrolled, so its visible text is what the native input was
// mounted with. This mock records that mount-time value + key, and counts the
// imperative calls the hook makes on the input's ref.
// `vi.mock` factories are hoisted above the module's imports, so React can only
// be reached through a dynamic import here.
vi.mock('react-native', async () => {
  const React = await import('react');
  const TextInput = React.forwardRef(function MockTextInput(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>
  ) {
    React.useImperativeHandle(
      ref,
      () => ({
        blur: () => {
          input.blurs += 1;
        },
        clear: () => {
          input.clears += 1;
        },
      }),
      []
    );
    input.mounts.push({ defaultValue: props.defaultValue as string | undefined });
    return React.createElement('TextInput', props);
  });
  return {
    I18nManager: { isRTL: false },
    Pressable: 'Pressable',
    TextInput,
    View: 'View',
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', X: 'X' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', foreground: '#111111' }),
}));
vi.mock('@/lib/persist/drafts', () => ({
  SESSION_SEARCH_DRAFT_KEY: 'session-search-query',
  saveDraft: vi.fn(),
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: () => undefined }));

type HookState = UseSessionSearchInputResult;
const latest = { current: null as HookState | null };

function Probe(props: UseSessionSearchInputParams): ReactElement {
  const state = useSessionSearchInput(props);
  latest.current = state;
  return createElement(SessionListSearchHeader, {
    inputRef: state.searchInputRef,
    hasText: state.hasText,
    showSearchBusy: false,
    onChangeText: state.handleSearchInputChange,
    onClearSearch: state.handleClearSearchInput,
    defaultValue: state.searchDefaultValue,
    inputKey: state.searchInputKey,
  });
}

const renderers: TestRenderer.ReactTestRenderer[] = [];

function mount(params: UseSessionSearchInputParams): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(Probe, params));
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  renderers.push(ref.current);
  return ref.current;
}

function hook(): HookState {
  if (!latest.current) {
    throw new Error('hook was not mounted');
  }
  return latest.current;
}

describe('useSessionSearchInput visible text', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    input.blurs = 0;
    input.clears = 0;
    input.mounts.length = 0;
    latest.current = null;
  });
  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
  });

  it('empties the field through a remount when the in-field X clears a restored draft', () => {
    const renderer = mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    act(() => {
      renderer.update(
        createElement(Probe, {
          userId: 'u1',
          restoredQuery: 'restored query',
          restoreSettled: true,
        })
      );
    });
    expect(input.mounts.at(-1)?.defaultValue).toBe('restored query');
    expect(hook().hasText).toBe(true);
    const mountsBeforeClear = input.mounts.length;

    act(() => {
      hook().handleClearSearchInput();
    });

    // The visible text is defined by the new mount, not by a native clear
    // command: no `clear()` is attempted at all, and the field mounts empty.
    expect(input.clears).toBe(0);
    expect(input.blurs).toBe(1);
    expect(input.mounts.at(-1)?.defaultValue).toBe('');
    // A new native input is what makes the visible text empty.
    expect(input.mounts).toHaveLength(mountsBeforeClear + 1);
    expect(hook().hasText).toBe(false);
    expect(hook().searchQuery).toBe('');
  });

  it('keeps a cleared field empty when the durable draft settles afterwards', () => {
    const renderer = mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    act(() => {
      hook().handleSearchInputChange('old query');
    });
    act(() => {
      hook().handleClearSearchInput();
    });
    expect(input.mounts.at(-1)?.defaultValue).toBe('');

    // The draft read was slow: it settles after the user cleared the field.
    // Seeding it back would show text the user already removed while the query
    // and the clear control stayed on the cleared state.
    act(() => {
      renderer.update(
        createElement(Probe, { userId: 'u1', restoredQuery: 'old query', restoreSettled: true })
      );
    });
    expect(input.mounts.at(-1)?.defaultValue).toBe('');
    expect(hook().hasText).toBe(false);
    expect(hook().searchQuery).toBe('');
  });
});
