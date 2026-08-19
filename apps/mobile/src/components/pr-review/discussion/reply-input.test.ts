/* eslint-disable max-lines -- cohesive suite for the Terms gate, reply draft clear, and settle-gate contracts */
// Four-state coverage for the UGC Terms gate (`ensureTermsAcceptedOutcome`).
//
//   - happy:          accept succeeds → `accepted`.
//   - retryable:      accept fails transiently → Retry CTA → retry succeeds.
//   - non-retryable:  accept rejected as stale (BAD_REQUEST) → `outdated`.
//   - empty:          already accepted → `accepted` with no gate shown.
//
// `Alert.alert` is captured so the test can press the Accept / Retry /
// Cancel buttons the gate renders. The gate is a pure async function, so no
// React mounting is required.

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureTermsAcceptedOutcome, ReplyInput } from './reply-input';
import { clearDraft } from '@/lib/persist/drafts';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';

type AlertButton = { text?: string; onPress?: () => void };
type AlertCall = { title: string; message: string; buttons: AlertButton[] };

const { alertCalls, getTermsStatusMock, acceptTermsMock, draftLoadMock } = vi.hoisted(() => ({
  alertCalls: [] as AlertCall[],
  getTermsStatusMock: vi.fn(),
  acceptTermsMock: vi.fn(),
  draftLoadMock: vi.fn((): { settled: boolean; value: string | null } => ({ settled: true, value: null })),
}));

vi.mock('react-native', () => ({
  Alert: {
    alert: (title: string, message: string, buttons: AlertButton[]) => {
      alertCalls.push({ title, message, buttons });
    },
  },
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('expo-web-browser', () => ({
  WebBrowser: { openBrowserAsync: vi.fn() },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    moderation: {
      getTermsStatus: { query: () => getTermsStatusMock() },
      acceptTerms: { mutate: (input: unknown) => acceptTermsMock(input) },
    },
  },
}));

vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

// `reply-input` imports the durable-draft chain, which pulls in the native
// encrypted-kv → expo-secure-store → expo-modules-core chain that the node
// test environment cannot resolve. Mock the persist chain and the identity
// hook so this suite stays node-only.
vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  prReplyDraftKey: vi.fn(() => 'pr-reply:key'),
  prMergeDraftKey: vi.fn(),
  prCommentDraftKey: vi.fn(),
}));

vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => draftLoadMock(),
}));

vi.mock('@/lib/persist/use-draft-flush', () => ({
  useDraftFlushOnBackground: vi.fn(),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));

// `ReplyInput` is mounted by calling it as a plain function (no renderer), so
// the React hook primitives are stubbed to no-op/simple versions, mirroring
// pr-merge-sheet.test.tsx. The pure `ensureTermsAcceptedOutcome` tests above
// do not touch these.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
    useMemo: vi.fn(<T>(factory: () => T) => factory()),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useEffect: vi.fn((effect: React.EffectCallback) => {
      effect();
    }),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
  };
});

/** Drains microtasks so the awaited getTermsStatus/acceptTerms settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function lastAlert(): AlertCall {
  const call = alertCalls.at(-1);
  if (!call) {
    throw new Error('No Alert was shown');
  }
  return call;
}

function pressButton(text: string): void {
  const button = lastAlert().buttons.find(b => b.text === text);
  if (!button) {
    throw new Error(`Button "${text}" not found`);
  }
  button.onPress?.();
}

function staleVersionError(): Error {
  const error = new Error('invalid_terms');
  Object.assign(error, { data: { code: 'BAD_REQUEST' } });
  return error;
}

describe('ensureTermsAcceptedOutcome', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    getTermsStatusMock.mockReset();
    acceptTermsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy: resolves accepted when the user accepts now', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockResolvedValue({ ok: true });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');

    await expect(promise).resolves.toEqual({ kind: 'accepted' });
    expect(acceptTermsMock).toHaveBeenCalledWith({ version: 'v1', agePosture: '13_plus' });
  });

  it('retryable: a transient accept failure shows a Retry CTA and retries the accept', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ ok: true });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');
    await flush();

    expect(lastAlert().message).toBe(
      "Couldn't accept the Terms. Check your connection and try again."
    );
    pressButton('Retry');

    await expect(promise).resolves.toEqual({ kind: 'accepted' });
    expect(acceptTermsMock).toHaveBeenCalledTimes(2);
  });

  it('retryable: cancelling the Retry CTA resolves dismissed without posting', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockRejectedValueOnce(new Error('Network request failed'));

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');
    await flush();
    pressButton('Cancel');

    await expect(promise).resolves.toEqual({ kind: 'dismissed' });
    expect(acceptTermsMock).toHaveBeenCalledTimes(1);
  });

  it('non-retryable: a stale-version reject resolves outdated (terminal, no post)', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockRejectedValueOnce(staleVersionError());

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');

    await expect(promise).resolves.toEqual({ kind: 'outdated' });
    // No retry alert is shown for a terminal reject.
    expect(alertCalls).toHaveLength(1);
  });

  it('empty: already accepted resolves accepted without showing the gate', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });

    await expect(ensureTermsAcceptedOutcome()).resolves.toEqual({ kind: 'accepted' });
    expect(alertCalls).toHaveLength(0);
    expect(acceptTermsMock).not.toHaveBeenCalled();
  });

  it('dismissed: cancelling the gate resolves dismissed', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Cancel');

    await expect(promise).resolves.toEqual({ kind: 'dismissed' });
    expect(acceptTermsMock).not.toHaveBeenCalled();
  });

  it('reports a getTermsStatus failure as unknown, not as acceptance', async () => {
    getTermsStatusMock.mockRejectedValueOnce(new Error('Network request failed'));

    await expect(ensureTermsAcceptedOutcome()).resolves.toEqual({ kind: 'unknown' });
    expect(alertCalls).toHaveLength(0);
  });
});

type ReplyMutation = ReturnType<typeof useReplyToCommentMutation>;

function makeReply(mutate: unknown): ReplyMutation {
  return { mutate, isPending: false, error: null } as unknown as ReplyMutation;
}

type FindElementArgs = {
  node: unknown;
  type: string;
  prop: string;
  value: unknown;
};

function findElement({ node, type, prop, value }: FindElementArgs): React.ReactElement | null {
  if (React.isValidElement(node)) {
    const element = node;
    const props = element.props as Record<string, unknown>;
    if (element.type === type && props[prop] === value) {
      return element;
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findElement({ node: child, type, prop, value });
        if (found) {
          return found;
        }
      }
    } else if (children !== undefined && children !== null) {
      const found = findElement({ node: children, type, prop, value });
      if (found) {
        return found;
      }
    }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement({ node: child, type, prop, value });
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/** Mounts ReplyInput, types a body, and presses the submit button. */
function mountAndSubmit(reply: ReplyMutation): void {
  // eslint-disable-next-line new-cap
  const element = ReplyInput({
    owner: 'octocat',
    repo: 'hello',
    number: 1,
    commentId: 42,
    reply,
  });
  const input = findElement({
    node: element,
    type: 'TextInput',
    prop: 'accessibilityLabel',
    value: 'Reply body',
  });
  if (!input) {
    throw new Error('Reply body TextInput not found');
  }
  (input.props as { onChangeText?: (value: string) => void }).onChangeText?.('hello');
  const button = findElement({
    node: element,
    type: 'Button',
    prop: 'accessibilityLabel',
    value: 'Submit reply',
  });
  if (!button) {
    throw new Error('Submit reply Button not found');
  }
  (button.props as { onPress?: () => void }).onPress?.();
}

describe('ReplyInput draft clear on submit', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    getTermsStatusMock.mockReset();
    acceptTermsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears the reply draft on a successful reply', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
    const mutate = vi.fn((_input: unknown, options: { onSuccess?: () => void }) => {
      options.onSuccess?.();
    });
    mountAndSubmit(makeReply(mutate));
    await flush();

    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-reply:key');
  });

  it('does not clear the reply draft on a failed reply', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
    // A failed mutation never invokes onSuccess, so the draft must survive.
    const mutate = vi.fn();
    mountAndSubmit(makeReply(mutate));
    await flush();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it('does not clear the reply draft when the terms gate is dismissed', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    const mutate = vi.fn();
    mountAndSubmit(makeReply(mutate));
    await flush();
    pressButton('Cancel');
    await flush();

    expect(mutate).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });
});

describe('ReplyInput seeds the field from the settled draft during render', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mountReplyInput(): React.ReactElement | null {
    return findElement({
      // eslint-disable-next-line new-cap
      node: ReplyInput({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        commentId: 42,
        reply: makeReply(vi.fn()),
      }),
      type: 'TextInput',
      prop: 'accessibilityLabel',
      value: 'Reply body',
    });
  }

  it('seeds the defaultValue from the settled draft value', () => {
    draftLoadMock.mockReturnValue({ settled: true, value: 'saved reply' });
    const input = mountReplyInput();
    if (!input) {
      throw new Error('Reply body TextInput not found');
    }
    expect((input.props as { defaultValue?: string }).defaultValue).toBe('saved reply');
  });

  it('seeds an empty field when the settled draft has no value (no stale previous-thread text)', () => {
    draftLoadMock.mockReturnValue({ settled: true, value: null });
    const input = mountReplyInput();
    if (!input) {
      throw new Error('Reply body TextInput not found');
    }
    expect((input.props as { defaultValue?: string }).defaultValue).toBe('');
  });
});

describe('ReplyInput gates input on draft settle', () => {
  it('hides the input and disables submit until the draft settles', () => {
    draftLoadMock.mockReturnValue({ settled: false, value: null });
    // eslint-disable-next-line new-cap
    const hidden = ReplyInput({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 42,
      reply: makeReply(vi.fn()),
    });
    expect(
      findElement({
        node: hidden,
        type: 'TextInput',
        prop: 'accessibilityLabel',
        value: 'Reply body',
      })
    ).toBeNull();
    const button = findElement({
      node: hidden,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Submit reply',
    });
    if (!button) {
      throw new Error('Submit reply Button not found');
    }
    expect((button.props as { disabled?: boolean }).disabled).toBe(true);

    draftLoadMock.mockReturnValue({ settled: true, value: null });
    // eslint-disable-next-line new-cap
    const shown = ReplyInput({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 42,
      reply: makeReply(vi.fn()),
    });
    expect(
      findElement({
        node: shown,
        type: 'TextInput',
        prop: 'accessibilityLabel',
        value: 'Reply body',
      })
    ).not.toBeNull();
  });
});
