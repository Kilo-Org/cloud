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
  focuses: 0,
  focused: true,
  mounts: [] as { defaultValue?: string }[],
}));
// The field is uncontrolled, so its visible text is what the native input was
// mounted with. The mount effect records that value; the imperative handle
// counts calls the hook makes on the input's ref.
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
          input.focused = false;
        },
        clear: () => {
          input.clears += 1;
        },
        focus: () => {
          input.focuses += 1;
          input.focused = true;
        },
        isFocused: () => input.focused,
      }),
      []
    );
    const initialDefaultValueRef = React.useRef(props.defaultValue);
    React.useEffect(() => {
      input.mounts.push({
        defaultValue: initialDefaultValueRef.current as string | undefined,
      });
    }, []);
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
/** Every render's body-driving values, in commit order. */
const renders: { restorePending: boolean; searchQuery: string }[] = [];

function Probe(props: UseSessionSearchInputParams): ReactElement {
  const state = useSessionSearchInput(props);
  latest.current = state;
  renders.push({ restorePending: state.restorePending, searchQuery: state.searchQuery });
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
    input.focuses = 0;
    input.focused = true;
    input.mounts.length = 0;
    latest.current = null;
    renders.length = 0;
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

  it('keeps focus when a broad clear remounts the uncontrolled field', () => {
    mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    act(() => {
      hook().handleSearchInputChange('search text');
    });
    act(() => {
      hook().clearSearchInput();
    });

    expect(input.clears).toBe(0);
    expect(input.focuses).toBe(1);
    expect(input.focused).toBe(true);
    expect(input.mounts.at(-1)?.defaultValue).toBe('');
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
    // The user's clear wins: no restore is pending, so the body stays on the
    // cleared (no-query) state instead of loading for a draft it will ignore.
    expect(hook().restorePending).toBe(false);
  });

  it('reports a pending restore until the saved search reaches the query state', () => {
    const renderer = mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    expect(hook().restorePending).toBe(true);
    expect(hook().searchQuery).toBe('');

    // The draft settles. The seed lands in the render after this one, so that
    // render still carries an empty query and a pending restore: a list body
    // that read the query there would paint the no-query state and replace it
    // one frame later.
    renders.length = 0;
    act(() => {
      renderer.update(
        createElement(Probe, { userId: 'u1', restoredQuery: 'Zebra', restoreSettled: true })
      );
    });
    expect(renders).toContainEqual({ restorePending: true, searchQuery: '' });
    expect(hook().restorePending).toBe(false);
    expect(hook().searchQuery).toBe('Zebra');
    expect(hook().hasText).toBe(true);
    expect(input.mounts.at(-1)?.defaultValue).toBe('Zebra');
  });

  it('clears the pending restore when an empty saved draft settles', () => {
    const renderer = mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    expect(hook().restorePending).toBe(true);

    // The saved draft is empty (a clear the last mount persisted). Nothing the
    // seed writes changes this render's values, so the flag alone has to end
    // the loading body; otherwise the screen waits for a render that never
    // comes.
    act(() => {
      renderer.update(
        createElement(Probe, { userId: 'u1', restoredQuery: '', restoreSettled: true })
      );
    });
    expect(hook().restorePending).toBe(false);
    expect(hook().searchQuery).toBe('');
    expect(hook().hasText).toBe(false);
  });

  it('does not wait on the draft once the user types', () => {
    const renderer = mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    act(() => {
      hook().handleSearchInputChange('Zeb');
    });
    expect(hook().restorePending).toBe(false);
    act(() => {
      renderer.update(
        createElement(Probe, { userId: 'u1', restoredQuery: 'Zebra', restoreSettled: true })
      );
    });
    expect(hook().restorePending).toBe(false);
    expect(hook().searchQuery).toBe('');
  });

  it('commits a restored whitespace-only draft as no search and keeps the spaces visible', () => {
    const renderer = mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    act(() => {
      renderer.update(
        createElement(Probe, { userId: 'u1', restoredQuery: '     ', restoreSettled: true })
      );
    });

    // Typing five spaces commits '' and lists every session; the restored
    // draft must commit the same query, or the list reads as empty while the
    // field looks blank.
    expect(hook().searchQuery).toBe('');
    expect(input.mounts.at(-1)?.defaultValue).toBe('     ');
    expect(hook().hasText).toBe(true);
    expect(hook().awaitingCommit).toBe(false);
  });

  it('commits a restored padded draft as its trimmed term and keeps the padding visible', () => {
    const renderer = mount({ userId: 'u1', restoredQuery: null, restoreSettled: false });
    act(() => {
      renderer.update(
        createElement(Probe, { userId: 'u1', restoredQuery: '  alpha ', restoreSettled: true })
      );
    });

    expect(hook().searchQuery).toBe('alpha');
    expect(input.mounts.at(-1)?.defaultValue).toBe('  alpha ');
    expect(hook().hasText).toBe(true);
    expect(hook().awaitingCommit).toBe(false);
  });
});
