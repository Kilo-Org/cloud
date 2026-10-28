import { beforeEach, describe, expect, it } from '@jest/globals';

import type { BouncerUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  decide,
  releaseDecideLease,
  type DecideResponse,
} from '@kilocode/web-shared/lib/bouncer/client';
import {
  anonymousBouncerRequest,
  signedInBouncerRequest,
  type BouncerUsageFields,
} from '@kilocode/web-shared/lib/bouncer/request';

const afterCallbacks: Array<() => Promise<unknown>> = [];
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: (callback: () => Promise<unknown>) => {
    afterCallbacks.push(callback);
  },
}));
jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/bouncer/client') as Record<string, unknown>),
  decide: jest.fn(),
  releaseDecideLease: jest.fn(),
}));

const mockedDecide = jest.mocked(decide);
const mockedReleaseDecideLease = jest.mocked(releaseDecideLease);

const CLOUDFLARE_IP = '104.16.0.1';
const JA4 = 't13d1516h2_8daaf6152771_02713d6af862';
const usageFields: BouncerUsageFields = {
  occurredAt: new Date('2026-01-01T00:00:00Z'),
  clientAttributed: true,
  requestedLogprobs: false,
  samples: null,
  promptSimHash: null,
};

function verdict(fields: Partial<DecideResponse>): DecideResponse {
  return { enforced: false, flags: [], spendWatch: false, ...fields } as DecideResponse;
}

async function runAfterCallbacks() {
  await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
}

beforeEach(() => {
  jest.resetAllMocks();
  afterCallbacks.length = 0;
  mockedDecide.mockResolvedValue(null);
  mockedReleaseDecideLease.mockResolvedValue(undefined);
});

describe('signedInBouncerRequest', () => {
  function signedIn(feature: 'cloud-agent' | null = 'cloud-agent') {
    return signedInBouncerRequest({
      ip: CLOUDFLARE_IP,
      ja4Digest: ` ${JA4.toUpperCase()} `,
      userId: 'user-1',
      organizationId: 'org-1',
      feature,
    });
  }

  it('sends the raw IP to decide and the payer-safe IP to usage under one request id', async () => {
    const bouncer = signedIn();
    await bouncer.decide({ tier: 'team', payer: undefined });

    expect(mockedDecide).toHaveBeenCalledTimes(1);
    expect(mockedDecide.mock.calls[0]?.[0]).toEqual({
      requestId: bouncer.requestId,
      tier: 'team',
      accountId: 'org:org-1',
      userId: 'user-1',
      ip: CLOUDFLARE_IP,
      ja4: JA4,
      accountCreatedAt: undefined,
      usedMicrodollars: undefined,
      acquiredMicrodollars: undefined,
    });
    expect(bouncer.usage(usageFields)).toEqual({
      ...usageFields,
      requestId: bouncer.requestId,
      accountId: 'org:org-1',
      clientIp: undefined,
    });
  });

  it('keeps a client-facing request IP on the usage row', () => {
    expect(signedIn(null).usage(usageFields).clientIp).toBe(CLOUDFLARE_IP);
  });

  it('waits for the account inputs before deciding', async () => {
    let resolveInputs: (value: { tier: 'paid' }) => void = () => undefined;
    const inputs = new Promise<{ tier: 'paid' }>(resolve => (resolveInputs = resolve));
    const verdictPromise = signedIn().decide(inputs);
    await Promise.resolve();
    expect(mockedDecide).not.toHaveBeenCalled();

    resolveInputs({ tier: 'paid' });
    await verdictPromise;
    expect(mockedDecide.mock.calls[0]?.[0]).toMatchObject({ tier: 'paid' });
  });

  it('fails open when the account inputs reject', async () => {
    const bouncer = signedIn();
    await expect(bouncer.decide(Promise.reject(new Error('balance failed')))).resolves.toBeNull();
    await runAfterCallbacks();
    expect(mockedDecide).not.toHaveBeenCalled();
    expect(mockedReleaseDecideLease).not.toHaveBeenCalled();
  });

  it('starts at most one decide per request', async () => {
    const bouncer = signedIn();
    await bouncer.decide({ tier: 'paid' });
    expect(() => bouncer.decide({ tier: 'paid' })).toThrow();
    expect(mockedDecide).toHaveBeenCalledTimes(1);
  });

  it('releases the spend-watch lease for the same request after the response', async () => {
    mockedDecide.mockResolvedValue(verdict({ spendWatch: true }));
    const bouncer = signedIn();
    await bouncer.decide({ tier: 'paid' });
    await runAfterCallbacks();

    expect(mockedReleaseDecideLease).toHaveBeenCalledTimes(1);
    expect(mockedReleaseDecideLease).toHaveBeenCalledWith({
      requestId: bouncer.requestId,
      accountId: 'org:org-1',
    });
  });
});

describe('anonymousBouncerRequest', () => {
  it('decides on the raw IP without an account and keeps that IP on usage', async () => {
    const bouncer = anonymousBouncerRequest({ ip: CLOUDFLARE_IP, ja4Digest: JA4 });
    await bouncer.decide();

    expect(mockedDecide.mock.calls[0]?.[0]).toEqual({
      requestId: bouncer.requestId,
      tier: 'anonymous',
      ip: CLOUDFLARE_IP,
      ja4: JA4,
    });
    expect(bouncer.usage(usageFields)).toMatchObject({
      requestId: bouncer.requestId,
      accountId: null,
      clientIp: CLOUDFLARE_IP,
    });
  });

  it('skips decide without an IP and never releases a lease', async () => {
    const bouncer = anonymousBouncerRequest({ ip: undefined, ja4Digest: undefined });
    await expect(bouncer.decide()).resolves.toBeNull();
    await runAfterCallbacks();
    expect(mockedDecide).not.toHaveBeenCalled();
    expect(mockedReleaseDecideLease).not.toHaveBeenCalled();
  });

  it('never releases a lease for an anonymous spend-watch verdict', async () => {
    mockedDecide.mockResolvedValue(verdict({ spendWatch: true }));
    await anonymousBouncerRequest({ ip: CLOUDFLARE_IP, ja4Digest: undefined }).decide();
    await runAfterCallbacks();
    expect(mockedReleaseDecideLease).not.toHaveBeenCalled();
  });
});

describe('apply', () => {
  function usage(): BouncerUsageContext {
    return { ...usageFields, requestId: 'r', accountId: 'user:u' };
  }
  const bouncer = () =>
    signedInBouncerRequest({
      ip: undefined,
      ja4Digest: undefined,
      userId: 'u',
      organizationId: undefined,
      feature: null,
    });

  it('rejects an enforced verdict without touching usage', () => {
    const context = usage();
    const response = bouncer().apply(
      verdict({ enforced: true, code: 'restricted', spendWatch: true }),
      context
    );
    expect(response?.status).toBe(403);
    expect(context.spendWatch).toBeUndefined();
  });

  it.each([
    ['a shadow verdict', verdict({ enforced: false, code: 'restricted', spendWatch: true }), true],
    ['a null verdict', null, false],
  ])('sends %s and records its spend watch', (_label, decided, spendWatch) => {
    const context = usage();
    expect(bouncer().apply(decided, context)).toBeNull();
    expect(context.spendWatch).toBe(spendWatch);
  });
});
