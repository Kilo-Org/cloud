/* eslint-disable max-lines -- one cohesive leave suite: the removal guard, the save queue behind it, and the failure paths share the navigator mock harness */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  changeRowText,
  commitRow,
  findAll,
  findFields,
  mountScreen,
  pressBack,
  pressButton,
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
    setCommands: { mutateAsync: vi.fn() },
  },
  back: vi.fn(),
  // The navigator side of `usePreventRemove`: while prevention is on, a
  // removal attempt is blocked and replayed through `repeat` only after the
  // screen has persisted its list.
  guard: {
    enabled: false,
    callback: undefined as ((options: { repeat: () => void }) => void) | undefined,
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    back: () => {
      if (h.guard.enabled && h.guard.callback) {
        h.guard.callback({
          repeat: () => {
            h.back();
          },
        });
        return;
      }
      h.back();
    },
  }),
  usePreventRemove: (enabled: boolean, handler: (options: { repeat: () => void }) => void) => {
    h.guard.enabled = enabled;
    h.guard.callback = handler;
  },
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
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', async () => {
  // vi.mock factories are hoisted above the module's imports, so the React
  // helpers must be loaded inside the factory.
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

describe('ProfileCommandsScreen Back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.guard.enabled = false;
    h.guard.callback = undefined;
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
  });

  it('saves the focused edit before the header Back leaves the screen', async () => {
    h.query.data = testProfile(['git fetch']);
    h.query.isPending = false;
    const pending = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync.mockReturnValueOnce(pending.promise);
    const { renderer, unmount } = await mountScreen();

    // No blur and no submit: the row keeps focus while Back is pressed.
    changeRowText(renderer.root, 0, 'git fetch --tags');
    pressBack(renderer.root);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 1);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenCalledWith({
      profileId: 'profile-1',
      commands: ['git fetch --tags'],
    });
    expect(h.back).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });

    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.back).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not write twice when a blur save is already in flight for Back', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const pending = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync.mockReturnValueOnce(pending.promise);
    const { renderer, unmount } = await mountScreen();

    changeRowText(renderer.root, 0, 'edited');
    commitRow(renderer.root, 0);
    pressBack(renderer.root);

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 1);
    expect(h.back).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });

    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.back).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps the screen and the draft when the Back save fails', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.setCommands.mutateAsync.mockRejectedValueOnce(error);
    const { renderer, unmount } = await mountScreen();

    changeRowText(renderer.root, 0, 'unsaved');
    pressBack(renderer.root);
    await waitFor(() => h.error.mock.calls.length > 0);

    expect(h.back).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith("Couldn't save setup commands");
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('unsaved');
    unmount();
  });

  it('sends the newest list after a pending save settles and leaves only then', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const first = Promise.withResolvers<{ success: boolean }>();
    const second = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { renderer, unmount } = await mountScreen();

    changeRowText(renderer.root, 0, 'first');
    commitRow(renderer.root, 0);
    changeRowText(renderer.root, 0, 'second');
    pressBack(renderer.root);

    // The newer whole list waits for the in-flight write instead of racing it.
    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 1);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['first'],
    });
    expect(h.back).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve({ success: true });
      await first.promise;
    });
    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 2);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['second'],
    });
    expect(h.back).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve({ success: true });
      await second.promise;
    });

    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.back).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('saves an edit typed while the Back write is in flight before leaving', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const first = Promise.withResolvers<{ success: boolean }>();
    const second = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { renderer, unmount } = await mountScreen();

    changeRowText(renderer.root, 0, 'first');
    pressBack(renderer.root);
    changeRowText(renderer.root, 0, 'second');
    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 1);
    expect(h.back).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve({ success: true });
      await first.promise;
    });
    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 2);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['second'],
    });
    expect(h.back).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve({ success: true });
      await second.promise;
    });
    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.back).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('leaves without a write when Back only dismisses an empty draft row', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const { renderer, unmount } = await mountScreen();

    pressButton(renderer.root);
    pressBack(renderer.root);

    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync).not.toHaveBeenCalled();
    expect(h.back).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not number a blank draft row as a command', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root);
    const labels = findAll(renderer.root, 'Pressable')
      .map(node => node.props.accessibilityLabel)
      .filter((label): label is string => typeof label === 'string');
    expect(labels.filter(label => label.startsWith('Move command '))).toEqual([
      'Move command 1 up',
      'Move command 1 down',
    ]);
    expect(labels).toContain('Move up');
    expect(labels).toContain('Move down');
    unmount();
  });

  it('arms the removal guard only while there is unsaved work or a write in flight', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const pending = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync.mockReturnValueOnce(pending.promise);
    const { renderer, unmount } = await mountScreen();

    // A clean list removes the route on the first attempt, as before.
    expect(h.guard.enabled).toBe(false);

    changeRowText(renderer.root, 0, 'edited');
    expect(h.guard.enabled).toBe(true);

    // The save hook records the payload before the write settles, so the list
    // already matches it; the in-flight write still holds the guard on.
    commitRow(renderer.root, 0);
    expect(h.guard.enabled).toBe(true);

    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });
    await waitFor(() => !h.guard.enabled);
    unmount();
  });

  it('saves the focused edit when a system back is blocked, then replays the leave', async () => {
    h.query.data = testProfile(['git fetch']);
    h.query.isPending = false;
    const pending = Promise.withResolvers<{ success: boolean }>();
    h.mutations.setCommands.mutateAsync.mockReturnValueOnce(pending.promise);
    const { renderer, unmount } = await mountScreen();

    // The navigator blocks the hardware-back removal and hands it to the guard.
    changeRowText(renderer.root, 0, 'git fetch --tags');
    act(() => {
      h.guard.callback?.({
        repeat: () => {
          h.back();
        },
      });
    });

    await waitFor(() => h.mutations.setCommands.mutateAsync.mock.calls.length === 1);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenCalledWith({
      profileId: 'profile-1',
      commands: ['git fetch --tags'],
    });
    expect(h.back).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });

    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.back).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps the screen and retries on the next system back when the save fails', async () => {
    h.query.data = testProfile(['a']);
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.setCommands.mutateAsync
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ success: true });
    const { renderer, unmount } = await mountScreen();

    changeRowText(renderer.root, 0, 'unsaved');
    act(() => {
      h.guard.callback?.({
        repeat: () => {
          h.back();
        },
      });
    });
    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.back).not.toHaveBeenCalled();
    expect(findFields(renderer.root)[0]?.props.nativeText).toBe('unsaved');

    act(() => {
      h.guard.callback?.({
        repeat: () => {
          h.back();
        },
      });
    });
    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenCalledTimes(2);
    expect(h.mutations.setCommands.mutateAsync).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      commands: ['unsaved'],
    });
    unmount();
  });
});
