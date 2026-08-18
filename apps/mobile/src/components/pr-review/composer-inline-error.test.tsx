// Terms-gate coverage for `useComposerInlineError`. The composer mirrors the
// reply-input / submit sheets: a terms-required classification prompts the
// gate, and an `outdated` outcome is terminal (bad-request copy, no retry).
// Only the hook is under test, so no full composer mount is required.

/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerInlineError } from './composer-inline-error';

const { ensureTermsAcceptedOutcomeMock, TERMS_OUTDATED } = vi.hoisted(() => ({
  ensureTermsAcceptedOutcomeMock: vi.fn(),
  TERMS_OUTDATED: 'The Terms of Service changed. Reopen this screen to accept the latest version.',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: () => ensureTermsAcceptedOutcomeMock(),
  TERMS_OUTDATED_COPY: TERMS_OUTDATED,
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

function Harness({ error, isEdit }: { error: unknown; isEdit: boolean }) {
  latestState = useComposerInlineError(error, isEdit);
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

async function mount(error: unknown, isEdit = false): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { error, isEdit }));
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

  it('clears the inline error when the gate returns accepted', async () => {
    ensureTermsAcceptedOutcomeMock.mockResolvedValue({ kind: 'accepted' });

    const renderer = await mount(termsRequiredError());

    expect(latestState?.inlineError).toBe(null);
    expect(latestState?.inlineErrorKind).toBe(null);

    renderer.unmount();
  });
});
