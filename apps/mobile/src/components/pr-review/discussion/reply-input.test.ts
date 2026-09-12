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

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { ensureTermsAcceptedOutcome, ReplyInput } from './reply-input';
import { clearDraft } from '@/lib/persist/drafts';
import { PR_OPERATION_AMBIGUOUS_MESSAGE } from '@/lib/pr-review/merge/pr-operation-ledger';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

type AlertButton = { text?: string; onPress?: () => void };
type AlertCall = { title: string; message: string; buttons: AlertButton[] };

const { alertCalls, getTermsStatusMock, acceptTermsMock, draftLoadMock, connectivity } = vi.hoisted(
  () => ({
    alertCalls: [] as AlertCall[],
    getTermsStatusMock: vi.fn(),
    acceptTermsMock: vi.fn(),
    draftLoadMock: vi.fn((): { settled: boolean; value: string | null } => ({
      settled: true,
      value: null,
    })),
    // The committed connectivity the submit gate reads; 'online' by default,
    // flipped per test. The real module pulls in NetInfo + the probe store,
    // which the node environment cannot resolve.
    connectivity: { value: 'online' as 'online' | 'offline' | 'unknown' },
  })
);

vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => connectivity.value,
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
// do not touch these. useState keeps a box per slot (same pattern as the
// composer test) so a press can flip the inline-error state and the next
// mount renders it. The same mock records every setter it hands out
// (`stateSetters`), so an error effect that writes its inline copy through
// one of them is observed even on a mount that never re-renders.
const stateSetters = vi.hoisted(() => [] as { mock: { calls: unknown[][] } }[]);
const hookState = vi.hoisted(() => ({ boxes: [] as unknown[], cursor: 0 }));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(<T>(initial: T) => {
      const index = hookState.cursor;
      hookState.cursor += 1;
      if (hookState.boxes.length <= index) {
        hookState.boxes.push(initial);
      }
      const setter = vi.fn((value: T) => {
        hookState.boxes[index] =
          typeof value === 'function'
            ? (value as (prev: T) => T)(hookState.boxes[index] as T)
            : value;
      });
      stateSetters.push(setter);
      return [hookState.boxes[index] as T, setter as (value: T) => void] as [T, (value: T) => void];
    }),
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

/** A reply mutation result frozen in its ERROR state (no request in flight). */
function makeFailedReply(error: unknown): ReplyMutation {
  return { mutate: vi.fn(), isPending: false, error } as unknown as ReplyMutation;
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

/** Mounts ReplyInput (one render pass: cursor restarts, boxes persist). */
function mountReplyInput(reply: ReplyMutation): React.ReactElement {
  hookState.cursor = 0;
  // eslint-disable-next-line new-cap
  return ReplyInput({
    owner: 'octocat',
    repo: 'hello',
    number: 1,
    commentId: 42,
    reply,
  });
}

/** Types a body into the mounted input and returns the submit button. */
function typeAndSubmit(element: React.ReactElement, text = 'hello'): void {
  const input = findElement({
    node: element,
    type: 'TextInput',
    prop: 'accessibilityLabel',
    value: 'Reply body',
  });
  if (!input) {
    throw new Error('Reply body TextInput not found');
  }
  (input.props as { onChangeText?: (value: string) => void }).onChangeText?.(text);
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

/** Drains the microtask queue plus one macrotask tick. */
async function flushMacrotask(): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

/** The mounted tree's inline error Text (absent when no error renders). */
function inlineErrorText(element: React.ReactElement): string | null {
  const texts = ((): React.ReactElement[] => {
    const found: React.ReactElement[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) {
          walk(child);
        }
        return;
      }
      if (!React.isValidElement(node)) {
        return;
      }
      if (node.type === 'Text') {
        found.push(node);
      }
      walk((node.props as Record<string, unknown>).children);
    };
    walk(element);
    return found;
  })();
  const error = texts.find(
    text =>
      typeof (text.props as { children?: unknown }).children === 'string' &&
      ((text.props as { className?: string }).className ?? '').includes('text-destructive')
  );
  return error ? (error.props as { children: string }).children : null;
}

/** Mounts ReplyInput, types a body, and presses the submit button. */
function mountAndSubmit(reply: ReplyMutation): void {
  const element = mountReplyInput(reply);
  typeAndSubmit(element);
}

describe('ReplyInput draft clear on submit', () => {
  beforeEach(() => {
    hookState.boxes = [];
    hookState.cursor = 0;
    alertCalls.length = 0;
    getTermsStatusMock.mockReset();
    acceptTermsMock.mockReset();
    connectivity.value = 'online';
    draftLoadMock.mockReturnValue({ settled: true, value: null });
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
  beforeEach(() => {
    hookState.boxes = [];
    hookState.cursor = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mountReplyBody(): React.ReactElement | null {
    return findElement({
      node: mountReplyInput(makeReply(vi.fn())),
      type: 'TextInput',
      prop: 'accessibilityLabel',
      value: 'Reply body',
    });
  }

  it('seeds the defaultValue from the settled draft value', () => {
    draftLoadMock.mockReturnValue({ settled: true, value: 'saved reply' });
    const input = mountReplyBody();
    if (!input) {
      throw new Error('Reply body TextInput not found');
    }
    expect((input.props as { defaultValue?: string }).defaultValue).toBe('saved reply');
  });

  it('seeds an empty field when the settled draft has no value (no stale previous-thread text)', () => {
    draftLoadMock.mockReturnValue({ settled: true, value: null });
    const input = mountReplyBody();
    if (!input) {
      throw new Error('Reply body TextInput not found');
    }
    expect((input.props as { defaultValue?: string }).defaultValue).toBe('');
  });
});

// ── Provider arm (s6) ────────────────────────────────────────────────

const GITLAB_REF: ProviderPrRef = { platform: 'gitlab', projectPath: 'octocat/hello', mrIid: 1 };

describe('ReplyInput provider arm (s6)', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    getTermsStatusMock.mockReset();
    acceptTermsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mountProviderReply(mutate: unknown): void {
    // eslint-disable-next-line new-cap
    const element = ReplyInput({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 42,
      reply: makeReply(mutate),
      provider: { ref: GITLAB_REF, threadId: 'D-77', commentNodeId: '9001' },
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

  it('posts the seam vars (provider-native ids), never the GitHub-shaped input', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
    const mutate = vi.fn((_input: unknown, options: { onSuccess?: () => void }) => {
      options.onSuccess?.();
    });
    mountProviderReply(mutate);
    await flush();

    expect(mutate).toHaveBeenCalledWith(
      { threadId: 'D-77', commentNodeId: '9001', body: 'hello' },
      expect.anything()
    );
  });

  it('folds the provider ref identity into the durable reply draft key', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
    const mutate = vi.fn((_input: unknown, options: { onSuccess?: () => void }) => {
      options.onSuccess?.();
    });
    mountProviderReply(mutate);
    await flush();

    // The mocked prReplyDraftKey answers 'pr-reply:key'; the provider arm
    // appends the collision-free ref identity (identity rule 17) so a
    // same-numbered GitHub PR can never share this reply's draft.
    expect(clearDraft).toHaveBeenCalledWith('u1', `pr-reply:key@${providerPrRefKey(GITLAB_REF)}`);
  });
});

describe('ReplyInput gates input on draft settle', () => {
  beforeEach(() => {
    hookState.boxes = [];
    hookState.cursor = 0;
  });

  it('hides the input and disables submit until the draft settles', () => {
    draftLoadMock.mockReturnValue({ settled: false, value: null });
    const hidden = mountReplyInput(makeReply(vi.fn()));
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
    const shown = mountReplyInput(makeReply(vi.fn()));
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

// ── s6f: refused-reply wording and failure copy ──────────────────────

/** True when the error effect wrote `value` into any state slot. */
function stateValueWritten(value: string): boolean {
  return stateSetters.some(setter => setter.mock.calls.some(call => call[0] === value));
}

function forbiddenError(): Error {
  return Object.assign(new Error('403 Forbidden'), { data: { code: 'FORBIDDEN' } });
}

// The failed-reply surface (uxs3 spot check, e6-offline-hang / e6-offline-
// banner): a generic provider failure shows the specified retryable copy —
// never the raw GitHub text — and a CONFIRMED-offline submit fails at once
// with that copy, without a request, keeping Reply enabled for the retry.
describe('ReplyInput refused-reply wording and failure copy', () => {
  beforeEach(() => {
    stateSetters.length = 0;
    hookState.boxes = [];
    hookState.cursor = 0;
    alertCalls.length = 0;
    getTermsStatusMock.mockReset();
    acceptTermsMock.mockReset();
    connectivity.value = 'online';
    draftLoadMock.mockReturnValue({ settled: true, value: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mountWithForbiddenError(provider?: {
    ref: ProviderPrRef;
    threadId: string;
    commentNodeId: string;
  }): void {
    const errored = {
      mutate: vi.fn(),
      isPending: false,
      error: forbiddenError(),
    } as unknown as ReplyMutation;
    // eslint-disable-next-line new-cap
    ReplyInput({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 42,
      reply: errored,
      provider,
    });
  }

  it('words a refused provider reply after the merge-request noun', () => {
    mountWithForbiddenError({ ref: GITLAB_REF, threadId: 'D-77', commentNodeId: '9001' });
    // The provider 403 must never read "pull request" on a merge request.
    expect(stateValueWritten("You don't have permission to reply to this merge request.")).toBe(
      true
    );
    expect(stateValueWritten("You don't have permission to reply to this pull request.")).toBe(
      false
    );
  });

  it('keeps the exact pre-s6 forbidden copy on the GitHub arm', () => {
    mountWithForbiddenError();
    expect(stateValueWritten("You don't have permission to reply to this pull request.")).toBe(
      true
    );
  });

  it('mirrors a generic provider failure as the retryable copy, never the raw message', () => {
    const raw = new Error(
      'You do not have access to this repository. Install the Kilo GitHub App to continue.'
    );
    // The mirror effect writes the state boxes during this mount; the next
    // render reads them back.
    mountReplyInput(makeFailedReply(raw));
    const shown = mountReplyInput(makeFailedReply(raw));
    expect(inlineErrorText(shown)).toBe('Could not reply.');
    // The raw provider text never reaches the tree at all.
    expect(JSON.stringify(shown)).not.toContain('Kilo GitHub App');
    // Retry stays offered: the button is not disabled by the retryable kind.
    const button = findElement({
      node: shown,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Submit reply',
    });
    if (!button) {
      throw new Error('Submit reply Button not found');
    }
    expect((button.props as { disabled?: boolean }).disabled).toBe(false);
  });

  it('mirrors the ambiguous ledger marker as the verify-before-retrying copy', () => {
    const ambiguous = new Error(PR_OPERATION_AMBIGUOUS_MESSAGE);
    mountReplyInput(makeFailedReply(ambiguous));
    const shown = mountReplyInput(makeFailedReply(ambiguous));
    expect(inlineErrorText(shown)).toBe(PR_OPERATION_AMBIGUOUS_MESSAGE);
  });

  it('fails a submit while CONFIRMED offline at once — no request, retryable copy, Reply stays enabled', async () => {
    connectivity.value = 'offline';
    const mutate = vi.fn();
    const element = mountReplyInput(makeReply(mutate));
    typeAndSubmit(element);
    await flushMacrotask();

    // No request was started (the hang behind the spinner with the disabled
    // Cancel is structurally impossible now), and the Terms gate never ran.
    expect(mutate).not.toHaveBeenCalled();
    expect(getTermsStatusMock).not.toHaveBeenCalled();

    const shown = mountReplyInput(makeReply(mutate));
    expect(inlineErrorText(shown)).toBe('Could not reply.');
    const button = findElement({
      node: shown,
      type: 'Button',
      prop: 'accessibilityLabel',
      value: 'Submit reply',
    });
    if (!button) {
      throw new Error('Submit reply Button not found');
    }
    expect((button.props as { disabled?: boolean }).disabled).toBe(false);

    // Back online: the same tap posts.
    connectivity.value = 'online';
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });
    typeAndSubmit(shown);
    await flushMacrotask();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
