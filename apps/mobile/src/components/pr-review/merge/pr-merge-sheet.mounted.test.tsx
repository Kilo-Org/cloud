import './pr-merge-sheet.test-mocks';
import { describe, expect, it } from 'vitest';
import * as Haptics from 'expo-haptics';
import { act } from '@/test/renderer';
import { consumeMergePartialSuccess } from '@/lib/pr-review/merge/merge-result-banner-store';
import {
  baseProps,
  button,
  draftKey,
  edit,
  hosts,
  mergeResult,
  mount,
  press,
  seedDraft,
  state,
  storedDraft,
  submit,
} from './pr-merge-sheet.test-support';

const ref = { owner: 'octocat', repo: 'hello', number: 1 };

describe('PrMergeSheet submission', () => {
  it('requires confirmation and submits the values edited in real fields', async () => {
    const renderer = await mount();
    await edit(renderer, 'Commit title', '  Edited title  ');
    await edit(renderer, 'Commit message', '  Edited message  ');
    await press(renderer, 'Merge');

    expect(state.merge.mutateAsync).not.toHaveBeenCalled();
    expect(hosts(renderer, 'ConfirmDialog')[0]?.props.title).toBe('Merge pull request?');
    await press(renderer, 'Confirm Merge');

    expect(state.merge.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      method: 'squash',
      expectedHeadSha: baseProps.headSha,
      commitTitle: 'Edited title',
      commitMessage: 'Edited message',
      deleteBranch: true,
    });
    expect(baseProps.onRefetch).toHaveBeenCalledOnce();
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success
    );
  });

  it('uses the rendered method and delete-branch controls on submit', async () => {
    const renderer = await mount();
    const rebase = hosts(renderer, 'Pressable').find(
      node => node.props.accessibilityLabel === 'Rebase and merge'
    );
    if (!rebase) {
      throw new Error('Rebase method missing');
    }
    await act(() => {
      (rebase.props.onPress as () => void)();
    });
    const toggle = hosts(renderer, 'Switch')[0];
    if (!toggle) {
      throw new Error('Delete branch toggle missing');
    }
    await act(() => {
      (toggle.props.onValueChange as (value: boolean) => void)(false);
    });
    await submit(renderer);

    expect(state.merge.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'rebase',
        deleteBranch: false,
      })
    );
  });

  it('clears a successfully merged draft without a partial-success banner', async () => {
    seedDraft('u1', draftKey, { title: 'Saved title', message: 'Saved message' });
    const renderer = await mount();
    await edit(renderer, 'Commit message', 'Pending message');
    await submit(renderer);

    expect(storedDraft()).toBeNull();
    expect(consumeMergePartialSuccess(ref)).toBeNull();
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
  });

  it('preserves a branch-delete warning while still completing the merge', async () => {
    state.merge.mutateAsync.mockResolvedValue({
      ...mergeResult,
      branchDeleted: false,
      branchDeleteError: 'Reference does not exist',
    });
    seedDraft('u1', draftKey, { title: 'Saved title', message: 'Saved message' });
    const renderer = await mount();
    await submit(renderer);

    expect(consumeMergePartialSuccess(ref)).toEqual({ reason: 'Reference does not exist' });
    expect(storedDraft()).toBeNull();
    expect(Haptics.notificationAsync).toHaveBeenCalledOnce();
    expect(baseProps.onRefetch).toHaveBeenCalledOnce();
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
  });

  it('confirms the real auto-merge CTA, submits edited values, and clears its draft', async () => {
    seedDraft('u1', draftKey, { title: 'Saved title', message: 'Saved message' });
    const renderer = await mount({ mode: 'enable-auto-merge' });
    await edit(renderer, 'Commit title', 'Auto title');
    await edit(renderer, 'Commit message', 'Auto message');
    await press(renderer, 'Enable auto-merge');
    expect(state.autoMerge.mutateAsync).not.toHaveBeenCalled();
    await press(renderer, 'Confirm Enable auto-merge');

    expect(state.autoMerge.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      prNodeId: 'pr-node-1',
      method: 'SQUASH',
      commitTitle: 'Auto title',
      commitMessage: 'Auto message',
    });
    expect(storedDraft()).toBeNull();
    expect(baseProps.onRefetch).toHaveBeenCalledOnce();
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
  });

  it('does not offer confirmation when every merge method is disabled', async () => {
    const renderer = await mount({
      repo: {
        ...baseProps.repo,
        allowMergeCommit: false,
        allowSquashMerge: false,
        allowRebaseMerge: false,
      },
    });
    expect(button(renderer, 'Merge').props.disabled).toBe(true);
    expect(hosts(renderer, 'ConfirmDialog')).toHaveLength(0);
    expect(state.merge.mutateAsync).not.toHaveBeenCalled();
  });
});
