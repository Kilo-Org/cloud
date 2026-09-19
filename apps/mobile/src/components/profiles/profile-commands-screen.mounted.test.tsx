import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  changeRowText,
  commitRow,
  findAll,
  findFields,
  findOne,
  mountScreen,
  pressableDisabled,
  pressPressable,
  rerenderScreen,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-commands-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  error: vi.fn(),
  query: {
    data: undefined as TestProfileDetail | undefined,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    setCommands: { mutateAsync: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', destructive: '#FF0000' }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', async () => {
  const { createElement, useRef } = await import('react');
  return {
    FormField: (props: { defaultValue?: string; onChangeText?: (value: string) => void }) => {
      // Native uncontrolled text only accepts defaultValue when mounted.
      const nativeText = useRef(props.defaultValue);
      return createElement('FormField', {
        ...props,
        nativeText: nativeText.current,
        onChangeText: (value: string) => {
          nativeText.current = value;
          props.onChangeText?.(value);
        },
      });
    },
  };
});
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

/** Press the add CTA the empty state renders through its `action` prop. */
function pressEmptyAction(renderer: Awaited<ReturnType<typeof mountScreen>>['renderer']): void {
  const action = findOne(renderer.root, 'EmptyState').props.action as {
    props: { onPress: () => void };
  };
  act(() => {
    action.props.onPress();
  });
}

describe('ProfileCommandsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
    Object.assign(h.mutations.setCommands, { isPending: false });
  });

  it('loading: renders skeletons and no rows', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(findFields(renderer.root)).toHaveLength(0);

    unmount();
  });

  it('error: renders QueryError and Retry refetches', async () => {
    Object.assign(h.query, { isError: true, isPending: false });

    const { renderer, unmount } = await mountScreen();

    const queryError = findOne(renderer.root, 'QueryError');
    act(() => {
      (queryError.props as { onRetry: () => void }).onRetry();
    });
    expect(h.query.refetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('empty: shows commandsEmpty and the add CTA opens an empty row', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No setup commands yet');
    pressEmptyAction(renderer);
    expect(findFields(renderer.root)[0]?.props.placeholder).toBe('e.g. pnpm install');

    unmount();
  });

  it('happy: a committed row persists the whole list', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeRowText(renderer.root, 0, 'pnpm install');
    commitRow(renderer.root, 0);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commands: ['pnpm install'],
    });

    unmount();
  });

  it('happy: moving a row persists the reordered list', async () => {
    h.query.data = testProfile(['a', 'b']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Move down', 0);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commands: ['b', 'a'],
    });

    unmount();
  });

  it('edge: the move buttons are disabled at both ends', async () => {
    h.query.data = testProfile(['a', 'b', 'c']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(pressableDisabled(renderer.root, 'Move up', 0)).toBe(true);
    expect(pressableDisabled(renderer.root, 'Move down', 0)).toBe(false);
    expect(pressableDisabled(renderer.root, 'Move down', 2)).toBe(true);
    expect(pressableDisabled(renderer.root, 'Move up', 2)).toBe(false);

    unmount();
  });

  it('happy: deleting a row persists the remaining list', async () => {
    h.query.data = testProfile(['a', 'b']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete', 0);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commands: ['b'],
    });

    unmount();
  });

  it('never persists the blank draft row add() opens', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    const addButton = findOne(renderer.root, 'Button');
    act(() => {
      (addButton.props as { onPress: () => void }).onPress();
    });
    pressPressable(renderer.root, 'Delete', 0);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commands: [],
    });

    unmount();
  });

  it('retryable: a failure with no message toasts the fallback and keeps the edit', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.setCommands.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();
    changeRowText(renderer.root, 0, 'pnpm install');
    commitRow(renderer.root, 0);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't save setup commands");
    expect(findFields(renderer.root)[0]?.props.defaultValue).toBe('pnpm install');

    unmount();
  });

  it('preserves edits typed while the saved list refetches', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, queryClient, unmount } = await mountScreen();
    changeRowText(renderer.root, 0, 'saved');
    commitRow(renderer.root, 0);
    changeRowText(renderer.root, 0, 'new draft');
    h.query.data = testProfile(['saved']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('new draft');
    commitRow(renderer.root, 0);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['new draft'],
    });
    unmount();
  });

  it('remounts clean uncontrolled fields when refreshed server values change', async () => {
    h.query.data = testProfile(['old']);
    h.query.isPending = false;
    const { renderer, queryClient, unmount } = await mountScreen();
    h.query.data = testProfile(['remote edit']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('remote edit');
    unmount();
  });

  it('ignores a stale refetch until a pending save settles without discarding newer text', async () => {
    h.query.data = testProfile(['old']);
    h.query.isPending = false;
    const pending = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync.mockReturnValueOnce(pending.promise);
    const { renderer, queryClient, unmount } = await mountScreen();
    changeRowText(renderer.root, 0, 'submitted');
    commitRow(renderer.root, 0);
    h.mutations.setCommands.isPending = true;
    changeRowText(renderer.root, 0, 'newer draft');
    h.query.data = testProfile(['old']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('newer draft');
    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });
    h.mutations.setCommands.isPending = false;
    h.query.data = testProfile(['submitted']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    commitRow(renderer.root, 0);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['newer draft'],
    });
    unmount();
  });

  it('keeps the rows while a refetch is in flight', async () => {
    h.query.data = testProfile(['pnpm install']);
    h.query.isPending = false;

    const { renderer, queryClient, unmount } = await mountScreen();

    h.query.isRefetching = true;
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });

    expect(findFields(renderer.root)[0]?.props.defaultValue).toBe('pnpm install');

    unmount();
  });
});
