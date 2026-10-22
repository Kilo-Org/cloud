import './pr-merge-sheet.test-mocks';
import { describe, expect, it } from 'vitest';
import { PR_OPERATION_PERSISTENCE_FAILED_MESSAGE } from '@/lib/pr-review/merge/pr-operation-ledger';
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
