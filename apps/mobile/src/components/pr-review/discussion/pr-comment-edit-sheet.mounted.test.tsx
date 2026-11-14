// Mounted coverage for the own-comment edit sheet: a rejection renders in the
// shared inline box, a retryable one keeps Save live for the same tap, and a
// terminal 404 (the comment is gone) keeps Save down with the sheet's copy.

import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { PrCommentEditSheet } from './pr-comment-edit-sheet';
import { i18n } from '@/i18n';

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

const { updateComment, gate, connectivity, confirmRequests, backHandler } = vi.hoisted(() => ({
  updateComment: { mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>() },
  gate: { ensureTermsAcceptedOutcome: vi.fn<() => Promise<{ kind: string }>>() },
  connectivity: { value: 'online' },
  confirmRequests: [] as ConfirmRequest[],
  backHandler: { current: null as null | (() => boolean) },
}));

// The Expo modules in this graph read the build-time `__DEV__` global when they
// load, and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backHandler.current = handler;
      return {
        remove: () => {
          backHandler.current = null;
        },
      };
    },
  },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: ConfirmRequest) => {
      confirmRequests.push(request);
    },
    dialog: null,
  }),
}));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
}));
vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
}));
vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: gate.ensureTermsAcceptedOutcome,
}));
vi.mock('@/lib/pr-review/discussion/use-pr-comment-crud-mutations', () => ({
  useUpdatePrCommentMutation: () => ({ mutateAsync: updateComment.mutateAsync }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  connectionRefusesWrites: () => connectivity.value === 'offline',
  getCommittedConnectivityStatus: () => connectivity.value,
}));

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 7,
  kind: 'conversation' as const,
  initialBody: 'original body',
  onDismiss: vi.fn(),
};

const mounted: ReactTestRenderer[] = [];

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(element);
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

function typeBody(renderer: ReactTestRenderer, text: string): void {
  act(() => {
    (renderer.root.findByType('CommentBodyField').props.onChangeText as (value: string) => void)(
      text
    );
  });
}

function saveButton(renderer: ReactTestRenderer) {
  const [first] = renderer.root.findAll(
    node =>
      Object.is(node.type, 'Button') &&
      node.findAll(child => child.props.children === i18n.t('common.save')).length > 0
  );
  if (!first) {
    throw new Error('missing Save button');
  }
  return first;
}

function cancelButton(renderer: ReactTestRenderer) {
  const [first] = renderer.root.findAll(
    node =>
      Object.is(node.type, 'Button') &&
      node.findAll(child => child.props.children === i18n.t('common.cancel')).length > 0
  );
  if (!first) {
    throw new Error('missing Cancel button');
  }
  return first;
}

function pressCancel(renderer: ReactTestRenderer): void {
  act(() => {
    (cancelButton(renderer).props.onPress as () => void)();
  });
}

async function pressSave(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    (saveButton(renderer).props.onPress as () => void)();
    await Promise.resolve();
  });
}

function saveDisabled(renderer: ReactTestRenderer): boolean {
  return saveButton(renderer).props.disabled as boolean;
}

function failureCopy(renderer: ReactTestRenderer): string | undefined {
  const status = renderer.root.findAllByType('AccessibleStatus')[0];
  const text = renderer.root.findAllByType('Text')[0];
  return (status?.props.message ?? text?.props.children) as string | undefined;
}

beforeEach(() => {
  confirmRequests.length = 0;
  backHandler.current = null;
  connectivity.value = 'online';
  updateComment.mutateAsync.mockReset();
  gate.ensureTermsAcceptedOutcome.mockReset();
  gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
  baseProps.onDismiss = vi.fn();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('PrCommentEditSheet', () => {
  it('asks once before discarding a changed body and dismisses on discard', async () => {
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));
    typeBody(renderer, 'edited body');
    pressCancel(renderer);

    expect(confirmRequests.at(-1)).toMatchObject({
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });
    // Keeping editing (never confirming) leaves the sheet open.
    expect(baseProps.onDismiss).not.toHaveBeenCalled();

    confirmRequests.at(-1)?.onConfirm();
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('runs the same discard gate on the header close and the hardware back', async () => {
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));
    typeBody(renderer, 'edited body');

    act(() => {
      (renderer.root.findByType('PrFormSheetHeader').props.onBack as () => void)();
    });
    expect(confirmRequests).toHaveLength(1);

    act(() => {
      backHandler.current?.();
    });
    expect(confirmRequests).toHaveLength(2);
  });

  it('dismisses an unchanged body without a discard confirm', async () => {
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));
    pressCancel(renderer);

    expect(confirmRequests).toHaveLength(0);
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fails an offline submit at once with the retryable copy and keeps Save live', async () => {
    connectivity.value = 'offline';
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));
    typeBody(renderer, 'edited body');
    await pressSave(renderer);

    expect(updateComment.mutateAsync).not.toHaveBeenCalled();
    expect(gate.ensureTermsAcceptedOutcome).not.toHaveBeenCalled();
    expect(failureCopy(renderer)).toBe(i18n.t('prReview.discussion.commentEditFailed'));
    expect(saveDisabled(renderer)).toBe(false);
  });

  it('writes nothing when the sheet is dismissed during the Terms read', async () => {
    const roundTrip = Promise.withResolvers<{ kind: string }>();
    gate.ensureTermsAcceptedOutcome.mockReturnValueOnce(roundTrip.promise);
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));
    typeBody(renderer, 'edited body');

    act(() => {
      (saveButton(renderer).props.onPress as () => void)();
    });
    pressCancel(renderer);

    await act(async () => {
      roundTrip.resolve({ kind: 'accepted' });
      await Promise.resolve();
    });

    expect(updateComment.mutateAsync).not.toHaveBeenCalled();
  });

  it('leaves Cancel live while the pre-submit Terms read is stalled', async () => {
    const roundTrip = Promise.withResolvers<{ kind: string }>();
    gate.ensureTermsAcceptedOutcome.mockReturnValueOnce(roundTrip.promise);
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));
    typeBody(renderer, 'edited body');

    act(() => {
      (saveButton(renderer).props.onPress as () => void)();
    });
    expect(saveDisabled(renderer)).toBe(true);

    // The sheet owns no Cancel lock for the gate: the user can still leave.
    pressCancel(renderer);
    expect(confirmRequests.at(-1)?.confirmLabel).toBe(i18n.t('common.discard'));

    roundTrip.resolve({ kind: 'dismissed' });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('saves an edited body and dismisses', async () => {
    updateComment.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    expect(saveDisabled(renderer)).toBe(false);
    await pressSave(renderer);

    expect(updateComment.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 7,
      kind: 'conversation',
      body: 'edited body',
    });
    expect(baseProps.onDismiss).toHaveBeenCalled();
  });

  it('keeps Save live after a retryable rejection', async () => {
    updateComment.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
    );
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    await pressSave(renderer);

    expect(failureCopy(renderer)).toBe(i18n.t('prReview.discussion.commentEditFailed'));
    expect(saveDisabled(renderer)).toBe(false);
  });

  it('keeps Save down when the comment no longer exists', async () => {
    updateComment.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { data: { code: 'NOT_FOUND' } })
    );
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    await pressSave(renderer);

    expect(failureCopy(renderer)).toBe(i18n.t('prReview.discussion.commentEditUnavailable'));
    expect(saveDisabled(renderer)).toBe(true);

    // Terminal: a comment that no longer exists cannot be saved by editing.
    typeBody(renderer, 'edited body again');
    expect(saveDisabled(renderer)).toBe(true);
  });

  it('does not post while the Terms gate is dismissed', async () => {
    gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'dismissed' });
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    await pressSave(renderer);

    expect(updateComment.mutateAsync).not.toHaveBeenCalled();
    expect(saveDisabled(renderer)).toBe(false);
  });
});
