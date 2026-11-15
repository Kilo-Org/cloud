import './pr-merge-sheet.test-mocks';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
  prOperationNotAdmittedError,
} from '@/lib/pr-review/merge/pr-operation-ledger';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import {
  baseProps,
  button,
  hosts,
  mount,
  state,
  submit,
  update,
  visibleText,
} from './pr-merge-sheet.test-support';

const gitlab: ProviderPrRef = { platform: 'gitlab', projectPath: 'octocat/hello', mrIid: 1 };
const bitbucket: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'hello',
  prId: 1,
};
function errorWithCode(message: string, code: string) {
  return Object.assign(new Error(message), { data: { code } });
}

describe('PrMergeSheet mounted errors', () => {
  it.each([
    { prRef: undefined, noun: 'pull request' },
    { prRef: gitlab, noun: 'merge request' },
  ])('blocks another merge after a forbidden $noun response', async ({ prRef, noun }) => {
    const error = errorWithCode('403 Forbidden', 'FORBIDDEN');
    state.merge.mutateAsync.mockRejectedValue(error);
    const renderer = await mount({ prRef });
    await submit(renderer);
    state.merge.error = error;
    await update(renderer, { prRef });
    expect(visibleText(renderer)).toContain(`You don't have permission to merge this ${noun}.`);
    expect(button(renderer, 'Merge').props.disabled).toBe(true);
    expect(baseProps.onDismiss).not.toHaveBeenCalled();
    expect(baseProps.onRefetch).not.toHaveBeenCalled();
  });

  it.each([
    { prRef: undefined, message: 'GitHub connection expired.' },
    { prRef: gitlab, message: 'GitLab connection expired' },
    { prRef: bitbucket, message: 'Bitbucket connection expired' },
  ])('shows the reconnect notice for $message', async ({ prRef, message }) => {
    state.merge.error = errorWithCode('revoked', 'PRECONDITION_FAILED');
    const renderer = await mount({ prRef });
    expect(hosts(renderer, 'AccessibleStatus').map(node => node.props.message)).toContain(message);
    expect(hosts(renderer, 'PrReviewReconnectNotice')).toHaveLength(1);
    expect(button(renderer, 'Merge').props.disabled).toBe(true);
    expect(state.merge.mutateAsync).not.toHaveBeenCalled();
  });

  it.each([
    'The merge request changed since it was loaded. Reload the merge request and try again.',
    'The merge request was closed without merging.',
  ])('shows the stale-head reason and prevents resubmission: %s', async message => {
    state.merge.error = errorWithCode(message, 'CONFLICT');
    const renderer = await mount({ prRef: gitlab });
    expect(visibleText(renderer)).toContain(message);
    expect(button(renderer, 'Merge').props.disabled).toBe(true);
    expect(baseProps.onDismiss).not.toHaveBeenCalled();
  });

  it('keeps a generic conflict retryable rather than misclassifying it as a stale head', async () => {
    state.merge.error = errorWithCode('A merge is already running', 'CONFLICT');
    const renderer = await mount({ prRef: gitlab });
    expect(visibleText(renderer)).toContain('A merge is already running');
    expect(button(renderer, 'Merge').props.disabled).toBe(false);
    await submit(renderer);
    expect(state.merge.mutateAsync).toHaveBeenCalledOnce();
  });

  it('does not allow retry after persistence of the operation outcome failed', async () => {
    state.merge.error = new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
    const renderer = await mount();
    expect(visibleText(renderer)).toContain(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
    expect(button(renderer, 'Merge').props.disabled).toBe(true);
  });

  it('does not offer a retry when the intent store refused the merge', async () => {
    // Nothing was sent, and only a settled intent frees a slot, so a retry
    // cannot succeed: the refusal is not a retryable failure.
    state.merge.error = prOperationNotAdmittedError(i18n.t('prReview.merge.couldNotMerge'));
    const renderer = await mount();
    expect(visibleText(renderer)).toContain(i18n.t('prReview.merge.couldNotMerge'));
    expect(button(renderer, 'Merge').props.disabled).toBe(true);
  });

  it('shows GitHub’s settled-merge conflict and prevents resubmission', async () => {
    // The GitHub reconcile settles the row as a moved head or a closed PR and
    // throws this one message (`github-pr-review-router.ts:1488`).
    const settled = 'GitHub reported a conflict for this PR';
    state.merge.error = errorWithCode(settled, 'CONFLICT');
    const renderer = await mount();
    expect(visibleText(renderer)).toContain(settled);
    expect(button(renderer, 'Merge').props.disabled).toBe(true);
  });

  it('keeps GitHub’s own conflict text retryable', async () => {
    // A raw 405/409 arrives unchanged, and the same CONFLICT code also carries
    // the live-lease and ambiguous markers, so the sheet must not block it.
    const raw = 'Head branch was modified. Review and try the merge again.';
    state.merge.error = errorWithCode(raw, 'CONFLICT');
    const renderer = await mount();
    expect(visibleText(renderer)).toContain(raw);
    expect(button(renderer, 'Merge').props.disabled).toBe(false);
  });

  it('renders an auto-merge mutation error and keeps the sheet open', async () => {
    const error = new Error('Unable to enable auto-merge');
    state.autoMerge.mutateAsync.mockRejectedValue(error);
    const renderer = await mount({ mode: 'enable-auto-merge' });
    await submit(renderer, 'Enable auto-merge');
    state.autoMerge.error = error;
    await update(renderer, { mode: 'enable-auto-merge' });
    expect(visibleText(renderer)).toContain(error.message);
    expect(button(renderer, 'Enable auto-merge').props.disabled).toBe(false);
    expect(baseProps.onDismiss).not.toHaveBeenCalled();
  });
});
