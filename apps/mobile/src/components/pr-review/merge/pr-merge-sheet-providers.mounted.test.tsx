import './pr-merge-sheet.test-mocks';
import { describe, expect, it } from 'vitest';
import { type ProviderPrMergeState } from '@kilocode/app-shared/provider-review';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';
import {
  baseProps,
  draftKey,
  edit,
  hosts,
  input,
  mount,
  press,
  seedDraft,
  state,
  storedDraft,
  submit,
  visibleText,
} from './pr-merge-sheet.test-support';

const gitlab: ProviderPrRef = { platform: 'gitlab', projectPath: 'octocat/hello', mrIid: 1 };
const bitbucket: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'hello',
  prId: 1,
};
const allowed: ProviderPrMergeState = {
  canMerge: true,
  approvalsRequired: 0,
  pipelineMustSucceed: false,
  conflicts: false,
  blockedReasons: [],
};

describe('PrMergeSheet provider behavior', () => {
  it('submits the edited GitLab title and message with the head fence and squash choice', async () => {
    const key = `${draftKey}@${providerPrRefKey(gitlab)}`;
    seedDraft('u1', key, { title: 'GitLab saved title', message: 'GitLab saved message' });
    seedDraft('u1', draftKey, { title: 'GitHub saved title', message: 'GitHub saved message' });
    const renderer = await mount({ prRef: gitlab, mergeState: allowed });
    expect(input(renderer, 'Commit title').props.defaultValue).toBe('GitLab saved title');
    await edit(renderer, 'Commit title', '  GitLab edit  ');
    await edit(renderer, 'Commit message', '  GitLab message  ');
    await press(renderer, 'Merge');
    expect(state.merge.mutateAsync).not.toHaveBeenCalled();
    expect(hosts(renderer, 'ConfirmDialog')[0]?.props.title).toBe('Merge merge request?');
    await press(renderer, 'Confirm Merge');

    expect(state.merge.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      expectedHeadSha: baseProps.headSha,
      squash: true,
      deleteBranch: true,
      commitTitle: 'GitLab edit',
      commitMessage: 'GitLab message',
    });
    expect(storedDraft('u1', key)).toBeNull();
    expect(storedDraft()?.title).toBe('GitHub saved title');
  });

  it('offers only Bitbucket merge and sends a message without an invisible title', async () => {
    const renderer = await mount({ prRef: bitbucket, mergeState: allowed });
    expect(hosts(renderer, 'TextInput').map(node => node.props.accessibilityLabel)).toEqual([
      'Commit message',
    ]);
    expect(hosts(renderer, 'Pressable').map(node => node.props.accessibilityLabel)).toEqual([
      'Create a merge commit',
    ]);
    await edit(renderer, 'Commit message', '  Bitbucket message  ');
    await submit(renderer);
    expect(state.merge.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      expectedHeadSha: baseProps.headSha,
      deleteBranch: true,
      commitMessage: 'Bitbucket message',
    });
  });

  it('replaces a blocked form with restrictions and keeps Cancel available', async () => {
    const renderer = await mount({
      prRef: gitlab,
      mergeState: {
        ...allowed,
        canMerge: false,
        approvalsRequired: 2,
        pipelineMustSucceed: true,
        conflicts: true,
        blockedReasons: [
          { code: 'conflicts', message: 'Provider conflict' },
          { code: 'failing_pipeline', message: 'Provider pipeline failure' },
          { code: 'other', message: 'A merge is already running' },
        ],
      },
    });
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    expect(hosts(renderer, 'Button').map(node => node.props.accessibilityLabel)).toEqual([
      'Cancel',
    ]);
    const text = visibleText(renderer);
    expect(text).toContain('2 approvals required');
    expect(text).toContain('The pipeline is failing on the latest commit.');
    expect(text).toContain('A merge is already running');
    expect(text.split('Resolve the merge conflicts on this branch before merging.')).toHaveLength(
      2
    );
    expect(text).not.toContain('The pipeline must succeed before merging.');
    await press(renderer, 'Cancel');
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
    expect(state.merge.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows restrictions without disconnecting an allowed form CTA', async () => {
    const renderer = await mount({
      prRef: gitlab,
      mergeState: { ...allowed, approvalsRequired: 2 },
    });
    expect(visibleText(renderer)).toContain('2 approvals required');
    expect(input(renderer, 'Commit title')).toBeDefined();
    await submit(renderer);
    expect(state.merge.mutateAsync).toHaveBeenCalledOnce();
  });

  it('arms GitLab auto-merge from the mounted CTA without sending form values', async () => {
    const key = `${draftKey}@${providerPrRefKey(gitlab)}`;
    seedDraft('u1', key, { title: 'Saved title', message: 'Saved message' });
    const renderer = await mount({
      prRef: gitlab,
      mode: 'enable-auto-merge',
      mergeState: { ...allowed, approvalsRequired: 2 },
      autoMergeCapability: { supported: true, reason: '' },
    });
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    expect(visibleText(renderer)).toContain('2 approvals required');
    await press(renderer, 'Enable auto-merge');
    expect(state.autoMerge.mutateAsync).not.toHaveBeenCalled();
    expect(hosts(renderer, 'ConfirmDialog')[0]?.props.message).toBe(
      'The merge request will merge automatically once its pipeline succeeds.'
    );
    await press(renderer, 'Confirm Enable auto-merge');
    expect(state.autoMerge.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      expectedHeadSha: baseProps.headSha,
    });
    expect(storedDraft('u1', key)).toBeNull();
    expect(baseProps.onRefetch).toHaveBeenCalledOnce();
    expect(baseProps.onDismiss).toHaveBeenCalledOnce();
  });

  it('explains unsupported Bitbucket auto-merge without a submission action', async () => {
    const reason = 'Bitbucket Cloud does not expose auto-merge in its API';
    const renderer = await mount({
      prRef: bitbucket,
      mode: 'enable-auto-merge',
      mergeState: allowed,
      autoMergeCapability: { supported: false, reason },
    });
    expect(visibleText(renderer)).toContain(reason);
    expect(hosts(renderer, 'TextInput')).toHaveLength(0);
    expect(hosts(renderer, 'Button').map(node => node.props.accessibilityLabel)).toEqual([
      'Cancel',
    ]);
    expect(state.autoMerge.mutateAsync).not.toHaveBeenCalled();
  });
});
