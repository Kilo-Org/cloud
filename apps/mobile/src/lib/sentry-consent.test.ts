import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reinitSentryForConsent, sentryOptionsForConsent } from './sentry-consent';

const flushMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const getClientMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/react-native', () => ({
  flush: flushMock,
  close: closeMock,
  getClient: getClientMock,
}));

type FakeClientOptions = {
  enabled?: boolean;
  tracesSampleRate?: number;
  profilesSampleRate?: number;
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
};

type FakeClient = {
  flush: (timeout?: number) => Promise<boolean>;
  getOptions: () => FakeClientOptions;
};

function fakeClient(seed?: Partial<FakeClientOptions>): FakeClient {
  // Stable options object: the implementation mutates `getOptions().enabled`
  // and the sample rates, so a fresh object per call would hide the silencing.
  const options: FakeClientOptions = { ...seed };
  return {
    // Kept so a test can assert the transition never touches the outgoing
    // client's transport drain (see the vr3 regression below).
    flush: (timeout?: number) => flushMock(timeout),
    getOptions: () => options,
  };
}

describe('sentryOptionsForConsent', () => {
  it('disables replay, screenshots, view-hierarchy, tracing, and profiling when consent is declined', () => {
    expect(sentryOptionsForConsent(false)).toEqual({
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
    });
  });

  it('enables masked replay and screenshots, never view-hierarchy, when consent is accepted', () => {
    const options = sentryOptionsForConsent(true);

    expect(options.attachScreenshot).toBe(true);
    expect(options.attachViewHierarchy).toBe(false);
    expect(options.replaysSessionSampleRate).toBe(0.1);
    expect(options.replaysOnErrorSampleRate).toBe(1);
    expect(options.tracesSampleRate).toBe(0.1);
  });

  it('sets tracesSampleRate to 0 when optional consent is declined', () => {
    expect(sentryOptionsForConsent(false).tracesSampleRate).toBe(0);
  });

  it('sets tracesSampleRate to 0.1 when optional consent is accepted', () => {
    expect(sentryOptionsForConsent(true).tracesSampleRate).toBe(0.1);
  });

  it('sets profilesSampleRate to 0 when optional consent is declined', () => {
    expect(sentryOptionsForConsent(false).profilesSampleRate).toBe(0);
  });

  it('sets profilesSampleRate above 0 when optional consent is accepted', () => {
    expect(sentryOptionsForConsent(true).profilesSampleRate).toBeGreaterThan(0);
  });
});

describe('reinitSentryForConsent', () => {
  beforeEach(() => {
    flushMock.mockReset();
    closeMock.mockReset();
    getClientMock.mockReset();
    flushMock.mockResolvedValue(true);
    // Default: the same client before and after the swap, so the
    // silence-outgoing step is a no-op in tests that do not care about it.
    const same = fakeClient();
    getClientMock.mockReturnValue(same);
  });

  it('never drains the outgoing client before the swap, and never closes it', async () => {
    // Regression (b911 vr3 device repro): @sentry/core bounds `client.flush(ms)`
    // with `ms` one-millisecond EVENT-LOOP TICKS, not wall-clock time, and a
    // live consented client never quiets (replay segments and the profiler keep
    // its processing count above 0, so the poll runs every tick). The awaited
    // "2 s" drain hung for over 14 minutes on the device; the swap sat behind
    // it, so the consented client stayed CURRENT and kept tracing, profiling
    // and emitting envelopes after the switch went to 0. Sentry.close() is
    // banned for its own reason (it latches the RN native wrapper off).
    await reinitSentryForConsent(false, vi.fn<(_: boolean) => void>());

    expect(flushMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('inits with the new consent before silencing the outgoing client', async () => {
    const events: string[] = [];
    const outgoing = fakeClient();
    const incoming = fakeClient();
    outgoing.getOptions = () => {
      events.push('silence');
      return { enabled: true };
    };
    getClientMock.mockReturnValueOnce(outgoing);
    getClientMock.mockReturnValue(incoming);
    const init = vi.fn((consented: boolean) => {
      events.push(`init:${consented}`);
    });

    await reinitSentryForConsent(true, init);

    // The swap must land first: silencing the outgoing client before
    // `Sentry.init` would drop mandatory crash reports queued pre-transition.
    expect(events).toEqual(['init:true', 'silence']);
  });

  it('disables the outgoing client after the swap so it stops sending envelopes', async () => {
    const outgoing = fakeClient();
    const incoming = fakeClient();
    // First getClient() sees the outgoing client; later ones see the swap.
    getClientMock.mockReturnValueOnce(outgoing);
    getClientMock.mockReturnValue(incoming);

    await reinitSentryForConsent(false, vi.fn<(_: boolean) => void>());

    expect(outgoing.getOptions().enabled).toBe(false);
    expect(incoming.getOptions().enabled).toBeUndefined();
  });

  it('zeros the outgoing client sample rates after the swap so it stops sampling work', async () => {
    // Regression (b911 vr2 device repro): a swapped-out consented client kept
    // its consented rates, so root-span sampling kept sampling NEW
    // transactions and running the Hermes profiler on them long after the
    // revoke — envelopes that can never send, built at profiling cost.
    // Root-span sampling reads the live options object at span start.
    const outgoing = fakeClient({
      tracesSampleRate: 1,
      profilesSampleRate: 1,
    });
    getClientMock.mockReturnValueOnce(outgoing);
    getClientMock.mockReturnValue(fakeClient());

    await reinitSentryForConsent(false, vi.fn<(_: boolean) => void>());

    const options = outgoing.getOptions();
    expect(options.tracesSampleRate).toBe(0);
    expect(options.profilesSampleRate).toBe(0);
  });

  it('keeps the outgoing client enabled when the swap never landed (fail-closed also threw)', async () => {
    const outgoing = fakeClient();
    getClientMock.mockReturnValue(outgoing);
    const init = vi.fn<(_: boolean) => void>(() => {
      throw new Error('init always fails');
    });

    await reinitSentryForConsent(true, init);

    // The outgoing client is still the only live one — mandatory crash
    // reporting must not be silenced too.
    expect(outgoing.getOptions().enabled).toBeUndefined();
  });

  it('re-initialises with init(false) when Sentry.init throws (fail-closed)', async () => {
    // The "Native is disabled" shape: the outgoing client is fine, the new
    // init throws synchronously — the app must land on the declined client.
    const events: string[] = [];
    const init = vi
      .fn<(_: boolean) => void>()
      .mockImplementationOnce((consented: boolean) => {
        events.push(`init:${consented}`);
        throw new Error('Native is disabled');
      })
      .mockImplementation((consented: boolean) => {
        events.push(`init:${consented}`);
      });
    const onFailure = vi.fn(() => {
      events.push('onFailure');
    });

    await reinitSentryForConsent(true, init, onFailure);

    expect(events).toEqual(['init:true', 'init:false', 'onFailure']);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('reports failure and keeps chain alive when init(false) throws too', async () => {
    const init = vi.fn<(_: boolean) => void>(() => {
      throw new Error('init always fails');
    });
    const onFailure = vi.fn<() => void>();

    await reinitSentryForConsent(true, init, onFailure);

    // onFailure must run even though init(false) threw.
    expect(onFailure).toHaveBeenCalledOnce();
    // init was called with false (fail-closed attempt).
    expect(init).toHaveBeenCalledWith(false);

    // A later consent transition must still run — the chain must not reject.
    await reinitSentryForConsent(false, init);
    expect(init).toHaveBeenCalledTimes(4);
  });

  it('serializes overlapping consent transitions in call order', async () => {
    const events: string[] = [];
    const init = vi.fn((consented: boolean) => {
      events.push(`init:${consented}`);
    });

    const first = reinitSentryForConsent(true, init);
    const second = reinitSentryForConsent(false, init);

    await Promise.all([first, second]);

    // A fast accept → revoke must not interleave two inits: each transition
    // waits for the previous one through the `lifecycle` chain.
    expect(events).toEqual(['init:true', 'init:false']);
  });
});
