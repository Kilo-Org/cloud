// Clear-rule and state coverage for the conversation (issue) comment
// composer's durable draft: cleared on a successful post and on a confirmed
// discard, kept on every failure path and on a keep-editing discard.
// `Alert.alert` is captured so the test can press the gate's buttons.
//
// The module mocks, fixtures, and element-query helpers live in
// pr-conversation-comment-composer.test-helpers. That import MUST stay first:
// the helpers register the module mocks while they are evaluated, and the
// composer, '@/i18n', and every mocked module below must resolve against
// them. The composer itself is mounted as a plain function (no renderer),
// mirroring pr-review-comment-composer.test.tsx.

import type * as React from 'react';
import {
  addCommentMocks,
  alertCalls,
  ambiguous,
  backHandler,
  baseProps,
  buttonByLabel,
  connectivity,
  dismissTriggers,
  DRAFT_KEY,
  draftLoadMock,
  flushMicrotasks,
  footerCancelTrigger,
  hookState,
  type InlineErrorProps,
  lastAlert,
  persistenceFailed,
  platformMock,
  pressButton,
  pressDiscard,
  pressKeepEditing,
  requireByType,
  termsGateMock,
  typeBody,
} from './pr-conversation-comment-composer.test-helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import * as Haptics from 'expo-haptics';
import { PrConversationCommentComposer } from './pr-conversation-comment-composer';
import { clearDraft, saveDraft } from '@/lib/persist/drafts';

function mountComposer(): React.ReactElement {
  // One render pass per mount call: the cursor restarts at 0 while the boxes
  // persist, mirroring React's state-across-renders semantics.
  hookState.cursor = 0;
  // eslint-disable-next-line new-cap
  return PrConversationCommentComposer(baseProps);
}

describe('PrConversationCommentComposer', () => {
  beforeEach(() => {
    hookState.boxes = [];
    hookState.cursor = 0;
    alertCalls.length = 0;
    backHandler.current = null;
    // The arming no longer depends on the platform; the iOS case (where RN
    // no-ops the event) has its own test below.
    platformMock.OS = 'android';
    persistenceFailed.value = false;
    ambiguous.value = false;
    connectivity.value = 'online';
    addCommentMocks.mutateAsync.mockReset();
    addCommentMocks.isPending = false;
    addCommentMocks.error = null;
    draftLoadMock.mockReturnValue({ settled: true, value: null });
    termsGateMock.mockReset().mockResolvedValue({ kind: 'accepted' });
    vi.clearAllMocks();
    // A successful clear is the default; the discard flow only dismisses
    // after the stored draft is confirmed removed.
    vi.mocked(clearDraft).mockResolvedValue(true);
  });

  it('posts nothing on an empty body and shows the local empty-body error', () => {
    let element = mountComposer();
    pressButton(element, 'Comment');

    expect(addCommentMocks.mutateAsync).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();

    element = mountComposer();
    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe('Comment body cannot be empty.');
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('bad-request');
    expect((inline.props as InlineErrorProps).inlineErrorIsLocal).toBe(true);
    // The local validation error keeps Comment down until the body changes:
    // retrying an empty post is the same dead end, so this is the one
    // bad-request that blocks (the server bad-request must not).
    expect((buttonByLabel(element, 'Comment').props as { disabled?: boolean }).disabled).toBe(true);
  });

  it('re-enables Comment for retry after a server bad-request failure', async () => {
    // The typed text survives the failed post through the durable draft (the
    // helpers module recreates refs per mount call, so the seed restores it).
    draftLoadMock.mockReturnValue({ settled: true, value: 'hello' });
    const error = new Error('rejected');
    Object.assign(error, { data: { code: 'BAD_REQUEST' } });
    addCommentMocks.error = error;
    let element = mountComposer();
    element = mountComposer();

    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      "This comment can't be posted. The pull request may have changed."
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('bad-request');
    // The failed post must never dead-end the composer: the typed text is
    // intact and Comment is live again for the retry (uxs2 spot check).
    expect((buttonByLabel(element, 'Comment').props as { disabled?: boolean }).disabled).toBe(
      false
    );
    pressButton(element, 'Comment');
    await flushMicrotasks();
    expect(addCommentMocks.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      body: 'hello',
    });
  });

  it('keeps Comment down only for the retry-blocking ledger persistence marker', () => {
    persistenceFailed.value = true;
    addCommentMocks.error = new Error('We could not record this action. Please try again later.');
    let element = mountComposer();
    element = mountComposer();

    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      'We could not record this action. Please try again later.'
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('bad-request');
    expect((buttonByLabel(element, 'Comment').props as { disabled?: boolean }).disabled).toBe(true);

    // Editing the body starts a fresh intent (new fingerprint, rotated key),
    // so the block lifts with the error.
    element = mountComposer();
    typeBody(element, 'edited');
    element = mountComposer();
    expect((buttonByLabel(element, 'Comment').props as { disabled?: boolean }).disabled).toBe(
      false
    );
  });

  it('saves typed text to the durable draft', () => {
    typeBody(mountComposer(), 'hello');

    expect(saveDraft).toHaveBeenCalledWith('u1', DRAFT_KEY, 'hello');
  });

  it('clears the draft, dismisses, and fires success haptics on a successful post', async () => {
    addCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const element = mountComposer();
    typeBody(element, 'hello');
    pressButton(element, 'Comment');
    await flushMicrotasks();

    expect(addCommentMocks.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      body: 'hello',
    });
    expect(clearDraft).toHaveBeenCalledWith('u1', DRAFT_KEY);
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success
    );
  });

  it('keeps the draft and shows the retryable copy (never the raw provider error) on a failed post', async () => {
    addCommentMocks.mutateAsync.mockRejectedValueOnce(new Error('Network request failed'));
    let element = mountComposer();
    typeBody(element, 'hello');
    pressButton(element, 'Comment');
    await flushMicrotasks();

    // The failure is preserved on the mutation error, so the next mount
    // mirrors it into the inline box.
    addCommentMocks.error = new Error('Network request failed');
    element = mountComposer();
    element = mountComposer();

    const inline = requireByType(element, 'ComposerInlineError');
    // The raw provider message (the backend's GitHub access/install text is
    // actionable to nobody) never reaches the inline box: the specified
    // retryable copy does (uxs3 spot check, e6-offline-banner).
    expect((inline.props as InlineErrorProps).inlineError).toBe('Could not post comment.');
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('retryable');
    // Draft intact: no clear, the typed text was saved.
    expect(clearDraft).not.toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledWith('u1', DRAFT_KEY, 'hello');
    expect(baseProps.onDismiss).not.toHaveBeenCalled();
    // Retry stays offered: Comment is enabled for the same tap to re-post.
    expect((buttonByLabel(element, 'Comment').props as { disabled?: boolean }).disabled).toBe(
      false
    );
  });

  it('shows the verify-before-retrying copy for the ambiguous ledger marker, not the generic one', () => {
    ambiguous.value = true;
    addCommentMocks.error = new Error('boom');
    mountComposer();
    const element = mountComposer();

    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      "Couldn't confirm — check the PR before retrying."
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('retryable');
    expect((buttonByLabel(element, 'Comment').props as { disabled?: boolean }).disabled).toBe(
      false
    );
  });

  it('fails a submit while CONFIRMED offline at once with the retryable copy — no request, no spinner, retry offered', async () => {
    // The hang the spot check caught: with the offline banner up, the tap
    // started a request that died on the 15s UI deadline behind a spinner
    // with a disabled Cancel, so retry was never offered (uxs3, e6-offline-
    // hang / e6-still-pending / e6). The gate rejects locally instead:
    // nothing is pending, the draft stays, Comment stays enabled.
    connectivity.value = 'offline';
    let element = mountComposer();
    typeBody(element, 'hello');
    pressButton(element, 'Comment');

    expect(addCommentMocks.mutateAsync).not.toHaveBeenCalled();
    expect(termsGateMock).not.toHaveBeenCalled();

    element = mountComposer();
    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe('Could not post comment.');
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('retryable');
    // Local rejection: announced through the inline box, not a toast.
    expect((inline.props as InlineErrorProps).inlineErrorIsLocal).toBe(true);
    expect((buttonByLabel(element, 'Comment').props as { disabled?: boolean }).disabled).toBe(
      false
    );
    expect(clearDraft).not.toHaveBeenCalled();
    expect(baseProps.onDismiss).not.toHaveBeenCalled();

    // Back online: the SAME control posts again — the retry path is live.
    // (The helpers module hands out fresh refs per mount call, so the body is
    // typed into the current render, mirroring the durable-draft restore.)
    connectivity.value = 'online';
    addCommentMocks.mutateAsync.mockResolvedValueOnce({});
    typeBody(element, 'hello');
    pressButton(element, 'Comment');
    await flushMicrotasks();
    expect(addCommentMocks.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['BAD_REQUEST', "This comment can't be posted. The pull request may have changed."],
    ['FORBIDDEN', "You don't have permission to comment on this pull request."],
  ])('maps a %s reject to the comment inline copy', (code, message) => {
    const error = new Error('rejected');
    Object.assign(error, { data: { code } });
    addCommentMocks.error = error;
    mountComposer();
    const element = mountComposer();

    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(message);
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe(
      code === 'BAD_REQUEST' ? 'bad-request' : 'forbidden'
    );
  });

  it('disables submit and the input while the mutation is pending', () => {
    addCommentMocks.isPending = true;
    const element = mountComposer();

    const button = requireByType(element, 'Button');
    const field = requireByType(element, 'CommentBodyField');
    expect((button.props as { disabled?: boolean }).disabled).toBe(true);
    expect((button.props as { loading?: boolean }).loading).toBe(true);
    expect((field.props as { isDisabled?: boolean }).isDisabled).toBe(true);
  });

  it.each(dismissTriggers)(
    'runs the discard gate on %s: keep-editing keeps, discard clears',
    async (_name, trigger) => {
      let element = mountComposer();
      typeBody(element, 'hello');
      trigger(element);
      expect(lastAlert().buttons.map(button => button.text)).toEqual(['Keep editing', 'Discard']);

      pressKeepEditing(lastAlert());
      expect(clearDraft).not.toHaveBeenCalled();
      expect(baseProps.onDismiss).not.toHaveBeenCalled();

      // Confirmed discard: the clear settles BEFORE the dismiss, so the next
      // open can never load the discarded text from the store mid-removal.
      element = mountComposer();
      typeBody(element, 'hello again');
      trigger(element);
      pressDiscard(lastAlert());
      expect(clearDraft).toHaveBeenCalledWith('u1', DRAFT_KEY);
      await flushMicrotasks();
      expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
    }
  );

  it.each(dismissTriggers)(
    'dismisses %s with an empty body without a discard confirm',
    (_name, trigger) => {
      const element = mountComposer();
      trigger(element);

      expect(alertCalls).toHaveLength(0);
      expect(clearDraft).not.toHaveBeenCalled();
      expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
    }
  );

  it('arms the hardware back listener on iOS too: one implementation, no platform fork', () => {
    // On iOS RN ships BackHandler as a never-firing no-op, so arming the
    // listener unconditionally is safe; the composer must not fork on the
    // platform to skip it.
    platformMock.OS = 'ios';
    mountComposer();

    expect(backHandler.current).toBeTypeOf('function');
  });

  it('stays on the composer with a retryable error when the discard clear fails', async () => {
    vi.mocked(clearDraft).mockResolvedValueOnce(false);
    let element = mountComposer();
    typeBody(element, 'hello');
    footerCancelTrigger(element);
    pressDiscard(lastAlert());
    await flushMicrotasks();

    expect(clearDraft).toHaveBeenCalledWith('u1', DRAFT_KEY);
    // The stored draft could not be removed: dismissing would resurface the
    // text on the next open, so the sheet stays and Cancel retries the clear.
    expect(baseProps.onDismiss).not.toHaveBeenCalled();

    element = mountComposer();
    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      'Could not discard the draft. Please try again.'
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('retryable');
    expect((inline.props as InlineErrorProps).inlineErrorIsLocal).toBe(true);
  });

  it('seeds the body field from the settled draft', () => {
    draftLoadMock.mockReturnValue({ settled: true, value: 'saved comment' });
    const element = mountComposer();

    const field = requireByType(element, 'CommentBodyField');
    expect((field.props as { defaultValue?: string }).defaultValue).toBe('saved comment');
  });
});
