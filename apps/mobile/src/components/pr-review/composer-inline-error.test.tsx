// Terms-gate coverage for `useComposerInlineError`. The composer mirrors the
// reply-input / submit sheets: a terms-required classification prompts the
// gate, and an `outdated` outcome is terminal (bad-request copy, no retry).
// One further case pins the surface-specific bad-request copy: the
// `'edit-comment'` surface selects the own-comment edit copy. Only the hook is
// under test, so no full composer mount is required.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type MutationErrorDisplaySurface } from '@/lib/pr-review/mutation-error-display';
import { useComposerInlineError } from './composer-inline-error';

const { ensureTermsAcceptedOutcomeMock, TERMS_CHECK_RETRY, TERMS_OUTDATED } = vi.hoisted(() => ({
  ensureTermsAcceptedOutcomeMock: vi.fn(),
  TERMS_CHECK_RETRY: "Couldn't check the Terms of Service. Check your connection and try again.",
  TERMS_OUTDATED: 'The Terms of Service changed. Reopen this screen to accept the latest version.',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: () => ensureTermsAcceptedOutcomeMock(),
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let latestState: ReturnType<typeof useComposerInlineError> | null = null;

function Harness({
  error,
  isEdit,
  surface,
}: {
  error: unknown;
  isEdit: boolean;
  surface?: MutationErrorDisplaySurface;
}) {
  latestState = useComposerInlineError(error, isEdit, surface);
  return null;
}

function termsRequiredError(): Error {
  const error = new Error('terms_required');
  Object.assign(error, { data: { code: 'PRECONDITION_FAILED', message: 'terms_required' } });
  return error;
}

/** Drains microtasks so the awaited terms gate promise and setState settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function mount(
  error: unknown,
  isEdit = false,
  surface?: MutationErrorDisplaySurface
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { error, isEdit, surface }));
    await flush();
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

describe('useComposerInlineError terms gate', () => {
  beforeEach(() => {
    latestState = null;
    ensureTermsAcceptedOutcomeMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets the terminal outdated copy when the gate returns outdated', async () => {
    ensureTermsAcceptedOutcomeMock.mockResolvedValue({ kind: 'outdated' });

    const renderer = await mount(termsRequiredError());

    expect(latestState?.inlineError).toBe(TERMS_OUTDATED);
    expect(latestState?.inlineErrorKind).toBe('bad-request');
    expect(latestState?.inlineErrorIsLocal).toBe(false);

    renderer.unmount();
  });

  it('keeps the local dismiss copy when the gate returns dismissed', async () => {
    ensureTermsAcceptedOutcomeMock.mockResolvedValue({ kind: 'dismissed' });

    const renderer = await mount(termsRequiredError());

    expect(latestState?.inlineError).toBe('You must accept the Terms of Service to post.');
    expect(latestState?.inlineErrorKind).toBe(null);
    expect(latestState?.inlineErrorIsLocal).toBe(true);

    renderer.unmount();
  });

  it('keeps a retryable error when the Terms status could not be read', async () => {
    ensureTermsAcceptedOutcomeMock.mockResolvedValue({ kind: 'unknown' });

    const renderer = await mount(termsRequiredError());

    expect(latestState?.inlineError).toBe(TERMS_CHECK_RETRY);
    expect(latestState?.inlineErrorKind).toBe('retryable');
    expect(latestState?.inlineErrorIsLocal).toBe(false);

    renderer.unmount();
  });

  it('clears the inline error when the gate returns accepted', async () => {
    ensureTermsAcceptedOutcomeMock.mockResolvedValue({ kind: 'accepted' });

    const renderer = await mount(termsRequiredError());

    expect(latestState?.inlineError).toBe(null);
    expect(latestState?.inlineErrorKind).toBe(null);

    renderer.unmount();
  });

  it("selects the edit-comment bad-request copy for the 'edit-comment' surface", async () => {
    const badRequest = new Error('Comment is too long');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });

    const renderer = await mount(badRequest, false, 'edit-comment');

    expect(latestState?.inlineError).toBe(
      "This comment can't be edited. It may have been deleted."
    );
    expect(latestState?.inlineErrorKind).toBe('bad-request');
    expect(latestState?.inlineErrorIsLocal).toBe(false);

    renderer.unmount();
  });
});
