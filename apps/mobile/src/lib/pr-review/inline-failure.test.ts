import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  classifyPrInlineFailure,
  prInlineNotRecordedFailure,
} from '@/lib/pr-review/inline-failure';
import {
  PR_OPERATION_AMBIGUOUS_MESSAGE,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
} from '@/lib/pr-review/merge/pr-operation-ledger';

// The classifier imports the Terms gate from the reply component; its terms
// branch is the only async dependency this suite drives directly.
const gate = vi.hoisted(() => ({
  ensureTermsAcceptedOutcome: vi.fn<() => Promise<{ kind: string }>>(),
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: gate.ensureTermsAcceptedOutcome,
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'pure-test-id' }));

function makeError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { data: { code } });
  return error;
}

beforeEach(() => {
  gate.ensureTermsAcceptedOutcome.mockReset();
});

describe('classifyPrInlineFailure', () => {
  it('publishes the ledger persistence marker as not-recorded on every surface', async () => {
    const error = new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
    const surfaces = ['composer', 'edit-comment', 'reply'] as const;
    const outcomes = await Promise.all(
      surfaces.map(surface => classifyPrInlineFailure(error, { surface, announce: 'toast' }))
    );
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ kind: 'failure', failure: prInlineNotRecordedFailure('toast') });
    }
  });

  it('publishes an ambiguous outcome as its own kind so the view can tell it apart', async () => {
    const outcome = await classifyPrInlineFailure(new Error(PR_OPERATION_AMBIGUOUS_MESSAGE), {
      surface: 'composer',
      announce: 'toast',
    });
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'ambiguous',
        message: i18n.t('prReview.operation.ambiguous'),
        announce: 'toast',
      },
    });
  });

  it('keeps the reply surface copy for a rejection', async () => {
    const outcome = await classifyPrInlineFailure(makeError('BAD_REQUEST', 'stale'), {
      surface: 'reply',
      announce: 'toast',
    });
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'bad-request',
        message: i18n.t('prReview.discussion.replyBadRequest'),
        announce: 'toast',
      },
    });
  });

  it('words a reply refusal after the connected provider', async () => {
    const outcome = await classifyPrInlineFailure(makeError('FORBIDDEN', 'server text'), {
      surface: 'reply',
      platform: 'gitlab',
      announce: 'toast',
    });
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'forbidden',
        message: i18n.t('prReview.discussion.replyForbiddenTerm', {
          term: i18n.t('common.mergeRequest'),
        }),
        announce: 'toast',
      },
    });
  });

  it('never shows the raw provider text on a generic reply failure', async () => {
    const outcome = await classifyPrInlineFailure(makeError('INTERNAL_SERVER_ERROR', 'raw'), {
      surface: 'reply',
      announce: 'silent',
    });
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'retryable',
        message: i18n.t('prReview.operation.couldNotReply'),
        announce: 'silent',
      },
    });
  });

  it('turns a reconnect rejection into the copy-free arm the notice owns', async () => {
    const outcome = await classifyPrInlineFailure(makeError('PRECONDITION_FAILED', 'expired'), {
      surface: 'composer',
      announce: 'toast',
    });
    expect(outcome).toEqual({ kind: 'failure', failure: { kind: 'reconnect' } });
  });

  it('reads a 404 on the edit surface as the terminal not-found arm', async () => {
    const outcome = await classifyPrInlineFailure(makeError('NOT_FOUND', 'gone'), {
      surface: 'edit-comment',
      announce: 'toast',
    });
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'not-found',
        message: i18n.t('prReview.discussion.commentEditUnavailable'),
        announce: 'toast',
      },
    });
  });

  it('uses the create-comment copy for a composer bad-request', async () => {
    const outcome = await classifyPrInlineFailure(makeError('BAD_REQUEST', 'stale'), {
      surface: 'composer',
      announce: 'toast',
    });
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'bad-request',
        message: i18n.t('prReview.mutationError.commentNotPosted'),
        announce: 'toast',
      },
    });
  });

  it('publishes the acceptance-required line when the gate is cancelled while recovering', async () => {
    gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'dismissed' });
    const composer = await classifyPrInlineFailure(
      makeError('PRECONDITION_FAILED', 'terms_required'),
      { surface: 'composer', announce: 'toast' }
    );
    expect(composer).toEqual({
      kind: 'failure',
      failure: {
        kind: 'retryable',
        message: i18n.t('prReview.discussion.termsAcceptRequired'),
        announce: 'here',
      },
    });

    const reply = await classifyPrInlineFailure(
      makeError('PRECONDITION_FAILED', 'terms_required'),
      { surface: 'reply', announce: 'toast' }
    );
    expect(reply).toEqual({
      kind: 'failure',
      failure: {
        kind: 'retryable',
        message: i18n.t('prReview.discussion.termsAcceptRequired'),
        announce: 'silent',
      },
    });
  });

  it('abandons the rejected write when the gate is accepted', async () => {
    gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
    const outcome = await classifyPrInlineFailure(
      makeError('PRECONDITION_FAILED', 'terms_required'),
      { surface: 'composer', announce: 'toast' }
    );
    expect(outcome).toEqual({ kind: 'abandoned' });
  });

  it('reports a stale terms version as a terminal bad-request', async () => {
    gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'outdated' });
    const outcome = await classifyPrInlineFailure(
      makeError('PRECONDITION_FAILED', 'terms_required'),
      { surface: 'composer', announce: 'toast' }
    );
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'bad-request',
        message: i18n.t('prReview.discussion.termsOutdatedCopy'),
        announce: 'toast',
      },
    });
  });

  it('reports an unreadable terms status as retryable', async () => {
    gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'unknown' });
    const outcome = await classifyPrInlineFailure(
      makeError('PRECONDITION_FAILED', 'terms_required'),
      { surface: 'reply', announce: 'toast' }
    );
    expect(outcome).toEqual({
      kind: 'failure',
      failure: {
        kind: 'retryable',
        message: i18n.t('prReview.discussion.termsCheckRetryCopy'),
        announce: 'toast',
      },
    });
  });
});
