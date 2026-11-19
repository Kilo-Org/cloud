import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountReadVerdict,
  useBlockedAccountFromAccountRead,
} from '@/lib/auth/account-blocked-read';
import { isBlockedAccountActive, setBlockedAccountActive } from '@/lib/auth/blocked-account-state';

// ── Fixtures ───────────────────────────────────────────────────────────────

const BLOCKED_REFUSAL = { data: { code: 'FORBIDDEN', accountBlocked: true } };
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
    setBlockedAccountActive(false);
  });

  it('raises the explanation on a blocked refusal', () => {
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });

    expect(isBlockedAccountActive()).toBe(true);

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
    const renderer = mount({ error: BLOCKED_REFUSAL, userId: undefined, enabled: true });
    expect(isBlockedAccountActive()).toBe(true);

    await update(renderer, { error: null, userId: 'user-1', enabled: false });

    expect(isBlockedAccountActive()).toBe(true);

    renderer.unmount();
  });

  it('does not clear a raise it did not make', () => {
    setBlockedAccountActive(true);
    const renderer = mount({ error: null, userId: 'user-1', enabled: true });

    expect(isBlockedAccountActive()).toBe(true);

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

    await update(renderer, { error: null, userId: 'user-1', enabled: false, onAnswered });
    expect(onAnswered).not.toHaveBeenCalled();

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
});
