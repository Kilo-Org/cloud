import './pr-merge-sheet.test-mocks';
import { describe, expect, it, vi } from 'vitest';
import { act } from '@/test/renderer';
import { DRAFT_DEBOUNCE_MS } from '@/lib/persist/drafts';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { MergeNotCompletedError } from '@/lib/pr-review/merge/merge-result-error';
import {
  baseProps,
  deferred,
  draftKey,
  edit,
  hosts,
  input,
  mount,
  mountPending,
  press,
  seedDraft,
  settle,
  state,
  storedDraft,
  submit,
  unmount,
  update,
} from './pr-merge-sheet.test-support';

describe('PrMergeSheet durable drafts', () => {
  it('debounces title and message edits into a real durable save', async () => {
    vi.useFakeTimers();
    const renderer = await mount();
    await edit(renderer, 'Commit title', 'Draft title');
    await edit(renderer, 'Commit message', 'Draft message');
    expect(storedDraft()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    });
    expect(storedDraft()).toEqual({ title: 'Draft title', message: 'Draft message' });
  });

  it('flushes a pending edit on passive back and restores it after remount', async () => {
    const renderer = await mount();
    await edit(renderer, 'Commit title', 'Keep my title');
    await edit(renderer, 'Commit message', 'Keep my message');
    const header = hosts(renderer, 'PrFormSheetHeader')[0];
    if (!header) {
      throw new Error('Sheet header missing');
    }
    await act(() => {
      (header.props.onBack as () => void)();
    });
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
    await unmount(renderer);
    expect(storedDraft()).toEqual({ title: 'Keep my title', message: 'Keep my message' });

    const restored = await mount();
    expect(input(restored, 'Commit title').props.defaultValue).toBe('Keep my title');
    expect(input(restored, 'Commit message').props.defaultValue).toBe('Keep my message');
    expect(input(restored, 'Commit title').props.value).toBeUndefined();
  });

  it('flushes the latest edit when the app backgrounds', async () => {
    const renderer = await mount();
    await edit(renderer, 'Commit message', 'Background message');
    await act(() => {
      for (const listener of state.backgroundListeners) {
        listener('background');
      }
    });
    expect(storedDraft()?.message).toBe('Background message');
  });

  it('explicit Cancel clears both stored and pending edits, even after unmount', async () => {
    seedDraft('u1', draftKey, { title: 'Stored title', message: 'Stored message' });
    const renderer = await mount();
    await edit(renderer, 'Commit message', 'Pending replacement');
    await press(renderer, 'Cancel');
    await unmount(renderer);
    expect(storedDraft()).toBeNull();
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
    const restored = await mount();
    expect(input(restored, 'Commit message').props.defaultValue).toBe('');
    expect(input(restored, 'Commit title').props.defaultValue).not.toBe('Stored title');
  });

  it.each(['merge', 'enable-auto-merge'] as const)(
    'retains edits after a failed %s mutation',
    async mode => {
      const mutation = mode === 'merge' ? state.merge : state.autoMerge;
      mutation.mutateAsync.mockRejectedValue(new MergeNotCompletedError({ sha: 'not-merged' }));
      const renderer = await mount({ mode });
      await edit(renderer, 'Commit title', 'Retained title');
      await edit(renderer, 'Commit message', 'Retained message');
      await submit(renderer, mode === 'merge' ? 'Merge' : 'Enable auto-merge');
      expect(baseProps.onDismiss).not.toHaveBeenCalled();
      expect(baseProps.onRefetch).not.toHaveBeenCalled();
      await unmount(renderer);
      expect(storedDraft()).toEqual({ title: 'Retained title', message: 'Retained message' });
      const restored = await mount({ mode });
      expect(input(restored, 'Commit title').props.defaultValue).toBe('Retained title');
      expect(input(restored, 'Commit message').props.defaultValue).toBe('Retained message');
    }
  );

  it('renders no form or submit action until identity and storage settle', async () => {
    state.identity = { userId: undefined, isLoading: true };
    const renderer = mountPending();
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    expect(hosts(renderer, 'Button')).toHaveLength(0);
    expect(state.getItem).not.toHaveBeenCalled();

    const read = deferred<string | null>();
    state.getItem.mockReturnValueOnce(read.promise);
    state.identity = { userId: 'u1', isLoading: false };
    await update(renderer);
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    expect(hosts(renderer, 'Button')).toHaveLength(0);
    await act(() => {
      read.resolve(JSON.stringify({ title: 'Loaded title', message: 'Loaded message' }));
    });
    expect(input(renderer, 'Commit title').props.defaultValue).toBe('Loaded title');
  });

  it('ignores an obsolete account load and saves only the current account values', async () => {
    const oldRead = deferred<string | null>();
    const newRead = deferred<string | null>();
    state.getItem.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const renderer = mountPending();
    state.identity = { userId: 'u2', isLoading: false };
    await update(renderer);
    await act(() => {
      oldRead.resolve(JSON.stringify({ title: 'Other account', message: 'Private text' }));
    });
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    await act(() => {
      newRead.resolve(JSON.stringify({ title: 'Current account', message: 'Current message' }));
    });
    expect(input(renderer, 'Commit title').props.defaultValue).toBe('Current account');
    await edit(renderer, 'Commit message', 'Current edit');
    await unmount(renderer);
    expect(storedDraft('u1')).toBeNull();
    expect(storedDraft('u2')).toEqual({ title: 'Current account', message: 'Current edit' });
  });

  it('hides a previously settled account form while the next identity loads', async () => {
    seedDraft('u1', draftKey, { title: 'First account', message: 'First message' });
    const renderer = await mount();
    const nextRead = deferred<string | null>();
    state.getItem.mockReturnValueOnce(nextRead.promise);
    state.identity = { userId: 'u2', isLoading: false };
    await update(renderer);
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    await act(() => {
      nextRead.resolve(null);
    });
    expect(input(renderer, 'Commit title').props.defaultValue).not.toBe('First account');
    expect(input(renderer, 'Commit message').props.defaultValue).toBe('');
  });

  it('fences entity loads and flushes an existing edit to its original PR key', async () => {
    const renderer = await mount();
    await edit(renderer, 'Commit title', 'First PR edit');
    const nextRead = deferred<string | null>();
    state.getItem.mockReturnValueOnce(nextRead.promise);
    await update(renderer, { number: 2, title: 'Second feature' });
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    expect(storedDraft()?.title).toBe('First PR edit');
    await act(() => {
      nextRead.resolve(null);
    });
    expect(input(renderer, 'Commit title').props.defaultValue).not.toBe('First PR edit');
    await edit(renderer, 'Commit title', 'Second PR edit');
    await unmount(renderer);
    expect(storedDraft()?.title).toBe('First PR edit');
    expect(storedDraft('u1', 'pr-merge:octocat/hello#2')?.title).toBe('Second PR edit');
  });

  it('does not publish a superseded PR read after the new PR has loaded', async () => {
    const oldRead = deferred<string | null>();
    state.getItem.mockReturnValueOnce(oldRead.promise);
    const renderer = mountPending();
    seedDraft('u1', 'pr-merge:octocat/hello#2', { title: 'Second PR', message: 'Second message' });
    await update(renderer, { number: 2 });
    await act(() => {
      oldRead.resolve(JSON.stringify({ title: 'Obsolete PR', message: 'Old message' }));
    });
    expect(input(renderer, 'Commit title').props.defaultValue).toBe('Second PR');
    expect(input(renderer, 'Commit message').props.defaultValue).toBe('Second message');
  });

  it('does not flush a previous authentication epoch into storage', async () => {
    const renderer = await mount();
    await edit(renderer, 'Commit title', 'Expired account edit');
    bumpAuthEpoch();
    await unmount(renderer);
    await settle();
    expect(storedDraft()).toBeNull();
  });
});
