/* eslint-disable max-lines -- one cohesive mounted suite: rendering states, reorder and delete labels, and the save/reconcile paths share the screen's mock harness */
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
  pressButton,
  pressMove,
  pressPressable,
  rerenderScreen,
  testCommands,
  type TestCommands,
} from '@/components/profiles/profile-commands-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';
import { resetFormDraftsForTests } from '@/lib/form-draft';

const h = vi.hoisted(() => ({
  error: vi.fn(),
  query: {
    data: undefined as TestCommands | undefined,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    setCommands: { mutateAsync: vi.fn() },
  },
  back: vi.fn(),
}));

const permissionState = vi.hoisted(() => ({ canManage: true }));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => permissionState.canManage,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileCommands: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back }),
  usePreventRemove: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', destructive: '#FF0000' }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
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
    resetFormDraftsForTests();
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
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
    h.query.data = testCommands();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No setup commands yet');
    pressEmptyAction(renderer);
    expect(findFields(renderer.root)[0]?.props.placeholder).toBe('e.g. pnpm install');

    unmount();
  });

  it('happy: a committed row persists the whole list', async () => {
    h.query.data = testCommands();
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
    h.query.data = testCommands(['a', 'b']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressMove(renderer.root, 'down', 1);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commands: ['b', 'a'],
    });

    unmount();
  });

  it('counts the characters left near the bound and names the bound at it', async () => {
    h.query.data = testCommands(['pnpm install']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    const counterTexts = () =>
      findAll(renderer.root, 'Text').filter(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.includes('characters remaining')
      );
    const hintTexts = () =>
      findAll(renderer.root, 'Text')
        .map(node => node.props.children)
        .filter((child): child is string => typeof child === 'string');

    // An ordinary command is far from the server bound, so the row stays quiet.
    expect(counterTexts()).toEqual([]);

    // Near the bound the row counts the room left, as the bare numeral the chat
    // composer and the new-session prompt show, with the counted sentence as its
    // accessible name.
    changeRowText(renderer.root, 0, 'a'.repeat(470));
    expect(counterTexts().map(node => node.props.children)).toEqual([30]);
    expect(counterTexts()[0]?.props.accessibilityLabel).toBe('30 characters remaining');
    expect(hintTexts()).not.toContain('The command is limited to 500 characters');

    // At the bound the sentence replaces the count: a zero count would restate it.
    changeRowText(renderer.root, 0, 'a'.repeat(500));
    expect(counterTexts()).toEqual([]);
    expect(hintTexts()).toContain('The command is limited to 500 characters');

    unmount();
  });

  it('names the bound for a saved command that already sits on it', async () => {
    h.query.data = testCommands(['a'.repeat(500)]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Text').filter(node => node.props.children === 0)).toEqual([]);
    const hintTexts = findAll(renderer.root, 'Text')
      .map(node => node.props.children)
      .filter((child): child is string => typeof child === 'string');
    expect(hintTexts).toContain('The command is limited to 500 characters');

    unmount();
  });

  it('names each reorder control by its one-based position', async () => {
    h.query.data = testCommands(['a', 'b', 'c']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const labels = findAll(renderer.root, 'Pressable')
      .map(node => node.props.accessibilityLabel)
      .filter(
        (label): label is string => typeof label === 'string' && label.startsWith('Move command ')
      );
    expect(labels).toEqual([
      'Move command 1 up',
      'Move command 1 down',
      'Move command 2 up',
      'Move command 2 down',
      'Move command 3 up',
      'Move command 3 down',
    ]);

    unmount();
  });

  it('names each delete control by its one-based position', async () => {
    h.query.data = testCommands(['a', 'b', 'c']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const trash = findAll(renderer.root, 'Pressable').filter(
      node => typeof node.props.accessibilityLabel === 'string'
    );
    expect(
      trash
        .map(node => node.props.accessibilityLabel as string)
        .filter(label => label.startsWith('Delete'))
    ).toEqual(['Delete command 1', 'Delete command 2', 'Delete command 3']);
    // Each destructive control also carries the row's place in the list, like
    // the move controls beside it.
    expect(
      trash
        .filter(node => String(node.props.accessibilityLabel).startsWith('Delete'))
        .map(node => node.props.accessibilityHint)
    ).toEqual(['1 / 3', '2 / 3', '3 / 3']);

    unmount();
  });

  it('names a blank draft row after the command slot it occupies', async () => {
    h.query.data = testCommands(['a']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root);

    // The draft row is the second slot in the list, so its controls name
    // command 2 and carry that place, exactly like the saved row above it.
    expect(findAll(renderer.root, 'Pressable').map(node => node.props.accessibilityLabel)).toEqual([
      'Move command 1 up',
      'Move command 1 down',
      'Delete command 1',
      'Move command 2 up',
      'Move command 2 down',
      'Delete command 2',
    ]);
    expect(
      findAll(renderer.root, 'Pressable')
        .filter(node => String(node.props.accessibilityLabel).startsWith('Delete'))
        .map(node => node.props.accessibilityHint)
    ).toEqual(['1 / 2', '2 / 2']);
    expect(findFields(renderer.root).map(node => node.props.label)).toEqual([
      'Command 1',
      'Command 2',
    ]);

    unmount();
  });

  it('edge: the move buttons are disabled at both ends', async () => {
    h.query.data = testCommands(['a', 'b', 'c']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(pressableDisabled(renderer.root, 'Move command 1 up')).toBe(true);
    expect(pressableDisabled(renderer.root, 'Move command 1 down')).toBe(false);
    expect(pressableDisabled(renderer.root, 'Move command 3 down')).toBe(true);
    expect(pressableDisabled(renderer.root, 'Move command 3 up')).toBe(false);

    unmount();
  });

  it('happy: deleting a row persists the remaining list', async () => {
    h.query.data = testCommands(['a', 'b']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete command 1', 0);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commands: ['b'],
    });

    unmount();
  });

  it('never persists the blank draft row add() opens', async () => {
    h.query.data = testCommands(['a']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    const addButton = findOne(renderer.root, 'Button');
    act(() => {
      (addButton.props as { onPress: () => void }).onPress();
    });
    pressPressable(renderer.root, 'Delete command 1', 0);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commands: [],
    });

    unmount();
  });

  it('retryable: a failure with no message toasts the fallback and keeps the edit', async () => {
    h.query.data = testCommands(['a']);
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
    h.query.data = testCommands(['a']);
    h.query.isPending = false;
    h.mutations.setCommands.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, queryClient, unmount } = await mountScreen();
    changeRowText(renderer.root, 0, 'saved');
    commitRow(renderer.root, 0);
    changeRowText(renderer.root, 0, 'new draft');
    h.query.data = testCommands(['saved']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('new draft');
    commitRow(renderer.root, 0);
    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 2);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['new draft'],
    });
    unmount();
  });

  it('remounts clean uncontrolled fields when refreshed server values change', async () => {
    h.query.data = testCommands(['old']);
    h.query.isPending = false;
    const { renderer, queryClient, unmount } = await mountScreen();
    h.query.data = testCommands(['remote edit']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('remote edit');
    unmount();
  });

  it('ignores a stale refetch until a pending save settles without discarding newer text', async () => {
    h.query.data = testCommands(['old']);
    h.query.isPending = false;
    const pending = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync.mockReturnValueOnce(pending.promise);
    const { renderer, queryClient, unmount } = await mountScreen();
    changeRowText(renderer.root, 0, 'submitted');
    commitRow(renderer.root, 0);
    changeRowText(renderer.root, 0, 'newer draft');
    h.query.data = testCommands(['old']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('newer draft');
    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });
    h.query.data = testCommands(['submitted']);
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    commitRow(renderer.root, 0);
    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 2);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['newer draft'],
    });
    unmount();
  });

  it('keeps the rows while a refetch is in flight', async () => {
    h.query.data = testCommands(['pnpm install']);
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

  it('numbers every row, including a blank draft row', async () => {
    h.query.data = testCommands(['pnpm install', 'pnpm build']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findFields(renderer.root).map(field => field.props.label)).toEqual([
      'Command 1',
      'Command 2',
    ]);

    pressButton(renderer.root);
    expect(findFields(renderer.root).map(field => field.props.label)).toEqual([
      'Command 1',
      'Command 2',
      'Command 3',
    ]);

    unmount();
  });
  it('keeps a typed command when the screen is mounted again', async () => {
    h.query.data = testCommands(['npm install']);
    h.query.isPending = false;

    const first = await mountScreen();
    pressButton(first.renderer.root, 0);
    changeRowText(first.renderer.root, 1, 'npm run build');
    first.unmount();

    const second = await mountScreen();
    expect(findFields(second.renderer.root).map(field => field.props.defaultValue)).toEqual([
      'npm install',
      'npm run build',
    ]);
    second.unmount();
  });
});
