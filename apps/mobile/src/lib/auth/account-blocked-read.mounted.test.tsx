import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountReadVerdict,
  useBlockedAccountFromAccountRead,
} from '@/lib/auth/account-blocked-read';
import {
  getBlockedAccountExplanation,
  isBlockedAccountActive,
  setBlockedAccountExplanation,
} from '@/lib/auth/blocked-account-state';
import { setSignOutActive } from '@/lib/auth/sign-out-state';

// ── Fixtures ───────────────────────────────────────────────────────────────

const BLOCKED_REFUSAL = { data: { code: 'FORBIDDEN', accountBlocked: true } };
// A second refusal with the same shape and a different identity: an attempt
// that settles after the surface was dismissed is a fresh publish, not the
// cached error object the raise was tied to.
const BLOCKED_RETRY_REFUSAL = { data: { code: 'FORBIDDEN', accountBlocked: true } };
const OTHER_FAILURE = new Error('network');

type ProbeProps = {
  error: unknown;
  userId: string | undefined;
  enabled: boolean;
  /** Defaults to settled (`false`): the fixtures describe reads that have
   *  finished, and only the in-flight cases opt into `true`. */
  fetching?: boolean;
  onAnswered?: () => void;
};

function Probe(props: ProbeProps): React.ReactElement {
  useBlockedAccountFromAccountRead({ ...props, fetching: props.fetching ?? false });
  return createElement('probe');
}

function mount(props: ProbeProps): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Probe, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function update(renderer: TestRenderer.ReactTestRenderer, props: ProbeProps): Promise<void> {
  await act(async () => {
    renderer.update(createElement(Probe, props));
    await Promise.resolve();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('accountReadVerdict', () => {
  it('reports a blocked refusal whatever the retained identity', () => {
    expect(accountReadVerdict(BLOCKED_REFUSAL, undefined)).toBe('refused-blocked');
    expect(accountReadVerdict(BLOCKED_REFUSAL, 'user-1')).toBe('refused-blocked');
  });

  it('reports an answer only for a null error carrying an id', () => {
    expect(accountReadVerdict(null, 'user-1')).toBe('answered');
    expect(accountReadVerdict(undefined, 'user-1')).toBe('answered');
  });

  it('reports an unsettled attempt for a failure, a missing id, or both', () => {
    expect(accountReadVerdict(null, undefined)).toBe('unsettled');
    expect(accountReadVerdict(OTHER_FAILURE, 'user-1')).toBe('unsettled');
    expect(accountReadVerdict(OTHER_FAILURE, undefined)).toBe('unsettled');
  });
});

describe('useBlockedAccountFromAccountRead', () => {
  beforeEach(() => {
    setBlockedAccountExplanation(null);
    // The fence is module-global: a case that closes it leaves it closed, so
    // every case starts with it reopened.
    setSignOutActive(false);
  });

  it('raises the explanation on a blocked refusal', () => {
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });

    expect(isBlockedAccountActive()).toBe(true);
    // A refusal that names no reason is treated as the account block.
    expect(getBlockedAccountExplanation()).toBe('account_blocked');

    renderer.unmount();
  });

  it('publishes the domain refusal the read carried', () => {
    const renderer = mount({
      error: {
        data: {
          code: 'FORBIDDEN',
          accountBlocked: true,
          accountBlockedReason: 'email_domain_blocked',
        },
      },
      userId: undefined,
      enabled: true,
    });

    expect(getBlockedAccountExplanation()).toBe('email_domain_blocked');

    renderer.unmount();
  });

  it('keeps the explanation when a later attempt settles unsettled', async () => {
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });
    expect(isBlockedAccountActive()).toBe(true);

    await update(renderer, { error: OTHER_FAILURE, userId: undefined, enabled: true });

    expect(isBlockedAccountActive()).toBe(true);

    renderer.unmount();
  });

  it('clears its own raise when the read answers again', async () => {
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });
    expect(isBlockedAccountActive()).toBe(true);

    await update(renderer, { error: null, userId: 'user-1', enabled: true });

    expect(isBlockedAccountActive()).toBe(false);

    renderer.unmount();
  });

  it('does not clear a raise while no session exists, even if the read answers', async () => {
    const onAnswered = vi.fn<() => void>();
    const renderer = mount({
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      onAnswered,
    });
    expect(isBlockedAccountActive()).toBe(true);

    await update(renderer, { error: null, userId: 'user-1', enabled: false, onAnswered });

    expect(isBlockedAccountActive()).toBe(true);
    expect(onAnswered).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('clears an externally raised explanation when the read answers', () => {
    // The raise came from another procedure's refusal (the shared query-cache
    // path), not from this hook: an answered identity read still proves the
    // block lifted, so it clears the explanation and refetches.
    const onAnswered = vi.fn<() => void>();
    setBlockedAccountExplanation('account_blocked');
    const renderer = mount({ error: null, userId: 'user-1', enabled: true, onAnswered });

    expect(isBlockedAccountActive()).toBe(false);
    expect(onAnswered).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('leaves the explanation cleared when the first answer arrives', () => {
    const renderer = mount({ error: null, userId: 'user-1', enabled: true });

    expect(isBlockedAccountActive()).toBe(false);

    renderer.unmount();
  });

  it('runs onAnswered once, on the clearing transition only', async () => {
    const onAnswered = vi.fn<() => void>();
    const renderer = mount({
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      onAnswered,
    });
    // The raise reveals the explanation; nothing has been revealed from under
    // it yet, so the tree must not be refetched.
    expect(isBlockedAccountActive()).toBe(true);
    expect(onAnswered).not.toHaveBeenCalled();

    await update(renderer, {
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      onAnswered,
    });
    expect(onAnswered).not.toHaveBeenCalled();

    await update(renderer, { error: OTHER_FAILURE, userId: undefined, enabled: true, onAnswered });
    expect(onAnswered).not.toHaveBeenCalled();

    // The session survives the block, so `enabled` stays true and the answered
    // attempt is the reveal.
    await update(renderer, { error: null, userId: 'user-1', enabled: true, onAnswered });
    expect(isBlockedAccountActive()).toBe(false);
    expect(onAnswered).toHaveBeenCalledTimes(1);

    // A later answered read is not a transition: the explanation is already
    // gone, and the tree was refetched once.
    await update(renderer, { error: null, userId: 'user-1', enabled: true, onAnswered });
    expect(onAnswered).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('does not run onAnswered for an answered read with no raise', async () => {
    const onAnswered = vi.fn<() => void>();
    const renderer = mount({ error: null, userId: 'user-1', enabled: true, onAnswered });
    expect(onAnswered).not.toHaveBeenCalled();

    await update(renderer, { error: null, userId: 'user-1', enabled: true, onAnswered });
    expect(onAnswered).not.toHaveBeenCalled();

    await update(renderer, { error: null, userId: 'user-1', enabled: false, onAnswered });
    await update(renderer, { error: null, userId: 'user-1', enabled: true, onAnswered });
    expect(onAnswered).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('keeps its raise while the answering attempt is still in flight', async () => {
    const onAnswered = vi.fn<() => void>();
    const renderer = mount({
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      onAnswered,
    });
    expect(isBlockedAccountActive()).toBe(true);

    // React Query clears `error` for the duration of a retry: without the
    // settled guard the overlay would drop here and return on the refusal.
    await update(renderer, {
      error: null,
      userId: 'user-1',
      enabled: true,
      fetching: true,
      onAnswered,
    });

    expect(isBlockedAccountActive()).toBe(true);
    expect(onAnswered).not.toHaveBeenCalled();

    // The same inputs once the attempt settles do clear it.
    await update(renderer, {
      error: null,
      userId: 'user-1',
      enabled: true,
      fetching: false,
      onAnswered,
    });

    expect(isBlockedAccountActive()).toBe(false);
    expect(onAnswered).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('does not re-raise a cached refusal after the surface was dismissed', async () => {
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });
    expect(isBlockedAccountActive()).toBe(true);

    // The overlay's Sign out clears the explanation; the session then ends and
    // the cached refusal is still the query's `error`.
    act(() => {
      setBlockedAccountExplanation(null);
    });
    await update(renderer, { error: BLOCKED_REFUSAL, userId: undefined, enabled: false });

    expect(isBlockedAccountActive()).toBe(false);

    renderer.unmount();
  });

  it('does not refetch for an answered read after an external clear', async () => {
    const onAnswered = vi.fn<() => void>();
    const renderer = mount({
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      onAnswered,
    });
    expect(isBlockedAccountActive()).toBe(true);

    // A sign-in cleared the flag: the explanation is already gone, so the
    // answered read reveals nothing and must not refetch the tree.
    act(() => {
      setBlockedAccountExplanation(null);
    });
    await update(renderer, { error: null, userId: 'user-1', enabled: true, onAnswered });

    expect(isBlockedAccountActive()).toBe(false);
    expect(onAnswered).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('does not re-raise the same refusal object while the flag is cleared', async () => {
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });
    expect(isBlockedAccountActive()).toBe(true);

    act(() => {
      setBlockedAccountExplanation(null);
    });
    // Same refusal, same session: the effect runs again because `fetching`
    // changed, and the attempt it names was already handled.
    await update(renderer, {
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      fetching: true,
    });

    expect(isBlockedAccountActive()).toBe(false);

    renderer.unmount();
  });

  it('does not re-raise a fresh refusal while sign-out is active', async () => {
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });
    expect(isBlockedAccountActive()).toBe(true);

    // The surface's Sign out clears the explanation, and sign-out closes the
    // fence synchronously; an attempt already in flight then refuses again.
    act(() => {
      setSignOutActive(true);
    });
    act(() => {
      setBlockedAccountExplanation(null);
    });
    await update(renderer, { error: BLOCKED_RETRY_REFUSAL, userId: undefined, enabled: true });

    expect(isBlockedAccountActive()).toBe(false);

    // Sign-in reopens the fence. The refusal object is unchanged; only
    // `fetching` differs, and that dependency is what re-runs the effect.
    act(() => {
      setSignOutActive(false);
    });
    await update(renderer, {
      error: BLOCKED_RETRY_REFUSAL,
      userId: undefined,
      enabled: true,
      fetching: true,
    });

    expect(isBlockedAccountActive()).toBe(true);

    renderer.unmount();
  });

  it('does not refetch for an answered read while sign-out is active', async () => {
    const onAnswered = vi.fn<() => void>();
    const renderer = mount({
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      onAnswered,
    });
    expect(isBlockedAccountActive()).toBe(true);

    act(() => {
      setSignOutActive(true);
    });
    // A retry that reaches the server before the token is revoked can still
    // answer; during the teardown even settling is a publish, so the fence
    // neither clears the explanation nor refetches with a dying token.
    await update(renderer, { error: null, userId: 'user-1', enabled: true, onAnswered });

    expect(isBlockedAccountActive()).toBe(true);
    expect(onAnswered).not.toHaveBeenCalled();

    renderer.unmount();
    act(() => {
      setSignOutActive(false);
    });
  });

  it('resets its raise across a full sign-out cycle', async () => {
    const onAnswered = vi.fn<() => void>();
    const renderer = mount({
      error: BLOCKED_REFUSAL,
      userId: undefined,
      enabled: true,
      onAnswered,
    });
    expect(isBlockedAccountActive()).toBe(true);

    act(() => {
      setSignOutActive(true);
    });
    // The token is gone, but the fence owns the teardown: the raise is kept
    // past the state that would otherwise forget it.
    await update(renderer, { error: null, userId: undefined, enabled: false, onAnswered });

    // Sign-in published credentials, reopened the fence, and cleared the
    // explanation the previous session raised.
    act(() => {
      setSignOutActive(false);
      setBlockedAccountExplanation(null);
    });
    await update(renderer, { error: null, userId: 'user-1', enabled: true, onAnswered });

    expect(isBlockedAccountActive()).toBe(false);
    // That block was dismissed by its own Sign out: the new session's first
    // settled answer must not refetch for it.
    expect(onAnswered).not.toHaveBeenCalled();

    renderer.unmount();
  });
});
