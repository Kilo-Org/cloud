import './pr-merge-sheet.test-mocks';
import { describe, expect, it, vi } from 'vitest';
import { act } from '@/test/renderer';
import { DRAFT_DEBOUNCE_MS, DRAFT_MAX_BYTES } from '@/lib/persist/drafts';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  defaultCommitMessage,
  defaultCommitTitle,
} from '@/lib/pr-review/merge/merge-commit-defaults';
import { MergeNotCompletedError } from '@/lib/pr-review/merge/merge-result-error';
import {
  baseProps,
  chipChecked,
  chooseChip,
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
    expect(storedDraft()).toEqual({
      title: 'Draft title',
      message: 'Draft message',
    });
  });

  it('stores only the method when a chip tap is the only edit', async () => {
    const renderer = await mount({ initialMethod: 'merge' });
    await chooseChip(renderer, 'Squash and merge');
    await unmount(renderer);
    // The default title and message were never the person's text, so the record
    // holds no text at all.
    expect(storedDraft()).toEqual({ method: 'squash' });

    const restored = await mount({
      initialMethod: 'merge',
      title: 'Renamed feature',
      bodyMarkdown: 'New body',
    });
    expect(chipChecked(restored, 'Squash and merge')).toBe(true);
    expect(input(restored, 'Commit title').props.defaultValue).toBe(
      defaultCommitTitle('Renamed feature', 1)
    );
    expect(input(restored, 'Commit message').props.defaultValue).toBe(
      defaultCommitMessage('New body')
    );
  });

  it('keeps a method-only tap when the derived message is over the draft cap', async () => {
    const body = 'x'.repeat(DRAFT_MAX_BYTES + 1);
    const renderer = await mount({ initialMethod: 'merge', bodyMarkdown: body });
    await chooseChip(renderer, 'Squash and merge');
    await unmount(renderer);
    // The message is no longer written, so the byte cap cannot drop the method.
    expect(storedDraft()).toEqual({ method: 'squash' });

    const restored = await mount({ initialMethod: 'merge', bodyMarkdown: body });
    expect(chipChecked(restored, 'Squash and merge')).toBe(true);
  });

  it('keeps the authored title of a record whose method this build cannot restore', async () => {
    seedDraft('u1', draftKey, { title: 'Stored title', method: 'octopus' });
    const renderer = await mount({ initialMethod: 'merge' });
    // The record loads instead of being read as a shape mismatch, so its text
    // survives; the unknown method falls back to the default chip.
    expect(input(renderer, 'Commit title').props.defaultValue).toBe('Stored title');
    expect(chipChecked(renderer, 'Create a merge commit')).toBe(true);
    expect(chipChecked(renderer, 'Squash and merge')).toBe(false);

    await edit(renderer, 'Commit message', 'Fresh message');
    await unmount(renderer);
    expect(storedDraft()).toEqual({ title: 'Stored title', message: 'Fresh message' });
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
    expect(storedDraft()).toEqual({
      title: 'Keep my title',
      message: 'Keep my message',
    });

    const restored = await mount();
    expect(input(restored, 'Commit title').props.defaultValue).toBe('Keep my title');
    expect(input(restored, 'Commit message').props.defaultValue).toBe('Keep my message');
    expect(input(restored, 'Commit title').props.value).toBeUndefined();
  });

  it('restores the chosen merge method with the draft after passive back', async () => {
    // The default here is the merge commit, so a restored Squash chip proves the
    // method came from the draft rather than from the initial prop.
    const renderer = await mount({ initialMethod: 'merge' });
    expect(chipChecked(renderer, 'Create a merge commit')).toBe(true);
    await chooseChip(renderer, 'Squash and merge');
    expect(chipChecked(renderer, 'Squash and merge')).toBe(true);
    const header = hosts(renderer, 'PrFormSheetHeader')[0];
    if (!header) {
      throw new Error('Sheet header missing');
    }
    await act(() => {
      (header.props.onBack as () => void)();
    });
    await unmount(renderer);
    expect(storedDraft()?.method).toBe('squash');

    const restored = await mount({ initialMethod: 'merge' });
    expect(chipChecked(restored, 'Squash and merge')).toBe(true);
    expect(chipChecked(restored, 'Create a merge commit')).toBe(false);
  });

  it('submits the merge method restored from the draft after a remount', async () => {
    seedDraft('u1', draftKey, { title: 'T', message: 'M', method: 'squash' });
    const renderer = await mount({ initialMethod: 'merge' });
    expect(chipChecked(renderer, 'Squash and merge')).toBe(true);
    await submit(renderer);
    expect(state.merge.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'squash' })
    );
  });

  it('falls back to the default when the stored merge method is not allowed', async () => {
    seedDraft('u1', draftKey, { title: 'T', message: 'M', method: 'rebase' });
    const renderer = await mount({
      initialMethod: 'rebase',
      repo: { ...baseProps.repo, allowRebaseMerge: false },
    });
    expect(
      hosts(renderer, 'Pressable').some(
        node => node.props.accessibilityLabel === 'Rebase and merge'
      )
    ).toBe(false);
    expect(chipChecked(renderer, 'Create a merge commit')).toBe(true);
    await submit(renderer);
    expect(state.merge.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'merge' })
    );
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
    seedDraft('u1', draftKey, {
      title: 'Stored title',
      message: 'Stored message',
      method: 'rebase',
    });
    const renderer = await mount();
    expect(chipChecked(renderer, 'Rebase and merge')).toBe(true);
    await edit(renderer, 'Commit message', 'Pending replacement');
    await press(renderer, 'Cancel');
    await unmount(renderer);
    expect(storedDraft()).toBeNull();
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
    const restored = await mount();
    expect(input(restored, 'Commit message').props.defaultValue).toBe('');
    expect(input(restored, 'Commit title').props.defaultValue).not.toBe('Stored title');
    // The discarded draft's method is gone too: the default is selected again.
    expect(chipChecked(restored, 'Squash and merge')).toBe(true);
    expect(chipChecked(restored, 'Rebase and merge')).toBe(false);
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
      expect(storedDraft()).toEqual({
        title: 'Retained title',
        message: 'Retained message',
      });
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
    // The sheet body is never empty: a placeholder holds the form's rows until
    // the account's draft is known, so the sheet does not present blank.
    expect(hosts(renderer, 'Skeleton').length).toBeGreaterThan(0);

    const read = deferred<string | null>();
    state.getItem.mockReturnValueOnce(read.promise);
    state.identity = { userId: 'u1', isLoading: false };
    await update(renderer);
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    expect(hosts(renderer, 'Button')).toHaveLength(0);
    expect(hosts(renderer, 'Skeleton').length).toBeGreaterThan(0);
    await act(() => {
      read.resolve(JSON.stringify({ title: 'Loaded title', message: 'Loaded message' }));
    });
    expect(input(renderer, 'Commit title').props.defaultValue).toBe('Loaded title');
    expect(hosts(renderer, 'Skeleton')).toHaveLength(0);
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
    expect(storedDraft('u2')).toEqual({
      title: 'Current account',
      message: 'Current edit',
    });
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
