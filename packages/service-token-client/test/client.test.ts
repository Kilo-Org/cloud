import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DENIED_RECHECK_MS,
  HELD_TOKEN_MARGIN_SECONDS,
  MINT_BATCH_WINDOW_MS,
  createServiceTokens,
  type MintTransport,
} from '../src/client';
import { ServiceTokenError } from '../src/errors';

const ATTEMPT_TIMEOUT_MS = 10_000;
const START = Date.UTC(2026, 10, 26, 12, 0, 0);
const WEB = { audience: 'web', scope: 'web:sts.canary' };
const INGEST = { audience: 'usage-ingest', scope: 'usage-ingest:sts.canary' };

type Answer = (request: MintRequest) => MintResult | Promise<MintResult>;

/** Issues every requested token for `lifetimeSeconds`, named after its audience, scope and call. */
function issueAll(lifetimeSeconds = 300): Answer {
  let call = 0;
  return request => {
    call += 1;
    const expiresAt = Math.floor(Date.now() / 1000) + lifetimeSeconds;
    return {
      status: 'ok',
      tokens: request.tokens.map(({ audience, scope }) => ({
        status: 'issued',
        audience,
        scope,
        token: `${scope}#${call}`,
        jti: `jti-${call}-${audience}`,
        expiresAt,
      })),
    };
  };
}

/** A transport whose answers the test scripts, one per call; the last one repeats. */
function scripted(...answers: Answer[]) {
  const requests: MintRequest[] = [];
  const transport = vi.fn<MintTransport>(async request => {
    requests.push(request);
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    return await answer(request);
  });
  return { transport, requests };
}

const unavailable: Answer = () => ({ status: 'unavailable', retryAfterSeconds: 10 });

/** Past the batch window and one 25 ms poll, so reads that joined another read's call return too. */
async function settle<T>(promise: Promise<T>, ms = MINT_BATCH_WINDOW_MS + 40): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return await promise;
}

async function settleError(promise: Promise<unknown>, ms?: number): Promise<ServiceTokenError> {
  const error = await settle(
    promise.then(
      () => null,
      (caught: unknown) => caught
    ),
    ms
  );
  if (!(error instanceof ServiceTokenError)) throw new Error(`expected a ServiceTokenError: ${String(error)}`);
  return error;
}

function client(transport: MintTransport) {
  return createServiceTokens(transport, { attemptTimeoutMs: ATTEMPT_TIMEOUT_MS });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('first use', () => {
  it('starts empty, mints once for concurrent reads, then serves from memory', async () => {
    const { transport } = scripted(issueAll());
    const tokens = client(transport);

    const reads = Promise.all([tokens.get(WEB), tokens.get(WEB), tokens.get(WEB)]);
    expect(await settle(reads)).toEqual(['web:sts.canary#1', 'web:sts.canary#1', 'web:sts.canary#1']);
    expect(transport).toHaveBeenCalledTimes(1);

    expect(await tokens.get(WEB)).toBe('web:sts.canary#1');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('mints only the audiences requested, in one call for reads in the same window', async () => {
    const { transport, requests } = scripted(issueAll());
    const tokens = client(transport);

    const reads = Promise.all([tokens.get(WEB), tokens.get(INGEST)]);
    expect(await settle(reads)).toEqual(['web:sts.canary#1', 'usage-ingest:sts.canary#1']);
    expect(requests).toEqual([{ tokens: [WEB, INGEST] }]);
  });

  it('a read after the window opens a new call', async () => {
    const { transport, requests } = scripted(issueAll());
    const tokens = client(transport);

    const first = tokens.get(WEB);
    await vi.advanceTimersByTimeAsync(MINT_BATCH_WINDOW_MS + 1);
    const second = tokens.get(INGEST);
    await settle(Promise.all([first, second]));
    expect(requests).toEqual([{ tokens: [WEB] }, { tokens: [INGEST] }]);
  });

  it('splits a batch over 8 audiences, and two scopes of one audience, into calls STS accepts', async () => {
    const { transport, requests } = scripted(issueAll());
    const tokens = client(transport);
    const targets = Array.from({ length: 10 }, (_, index) => ({
      audience: `svc-${index}`,
      scope: `svc-${index}:read`,
    }));
    targets.push({ audience: 'svc-0', scope: 'svc-0:write' });

    const values = await settle(Promise.all(targets.map(target => tokens.get(target))));
    values.forEach((value, index) => expect(value).toMatch(new RegExp(`^${targets[index].scope}#[12]$`)));
    expect(requests.map(request => request.tokens.length)).toEqual([8, 3]);
    for (const request of requests) {
      const audiences = request.tokens.map(token => token.audience);
      expect(new Set(audiences).size).toBe(audiences.length);
    }
    expect(requests.flatMap(request => request.tokens)).toHaveLength(11);
  });

  it('refuses a scope of another audience without calling STS', async () => {
    const { transport } = scripted(issueAll());
    const error = await settleError(client(transport).get({ audience: 'web', scope: 'usage-ingest:x' }));
    expect(error).toMatchObject({ reason: 'denied', deniedReason: 'invalid_request' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('renewal', () => {
  it('renews at 80 % of the lifetime in the background, serving the held token meanwhile', async () => {
    const { transport } = scripted(issueAll());
    const tokens = client(transport);
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary#1');

    await vi.advanceTimersByTimeAsync(239_000);
    expect(await tokens.get(WEB)).toBe('web:sts.canary#1');
    expect(transport).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    const waitUntil = vi.fn();
    expect(await tokens.get(WEB, { waitUntil })).toBe('web:sts.canary#1');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINT_BATCH_WINDOW_MS + 5);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await tokens.get(WEB)).toBe('web:sts.canary#2');
  });

  it('serves the held token while renewal fails until exp minus the margin, never past it', async () => {
    const { transport } = scripted(issueAll(), unavailable);
    const tokens = client(transport);
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary#1');

    // 241 s: renewal starts and fails; the held token still serves.
    await vi.advanceTimersByTimeAsync(241_000);
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary#1');
    expect(transport).toHaveBeenCalledTimes(2);

    // Just before exp - 30 s, retries keep failing and the held token still serves.
    await vi.advanceTimersByTimeAsync((300 - HELD_TOKEN_MARGIN_SECONDS - 241) * 1000 - 1_000);
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary#1');

    // From exp - 30 s on, the read fails with the retry time.
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await settleError(tokens.get(WEB));
    expect(error.reason).toBe('unavailable');
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error.message).not.toContain('web:sts.canary#');
  });

  it('a late answer of a timed-out attempt still lands', async () => {
    const { transport } = scripted(async request => {
      const late = Promise.withResolvers<void>();
      setTimeout(late.resolve, ATTEMPT_TIMEOUT_MS + 2_000);
      await late.promise;
      return issueAll()(request);
    });
    const tokens = client(transport);
    const error = await settleError(tokens.get(WEB), ATTEMPT_TIMEOUT_MS + 100);
    expect(error.reason).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await tokens.get(WEB)).toBe('web:sts.canary#1');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('failures', () => {
  it('a cold read fails with the retry time STS sent, then waits out the backoff', async () => {
    const { transport } = scripted(unavailable, issueAll());
    const tokens = client(transport);
    const error = await settleError(tokens.get(WEB));
    expect(error).toMatchObject({ reason: 'unavailable' });
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(9);

    const again = await settleError(tokens.get(WEB));
    expect(again.reason).toBe('unavailable');
    expect(transport).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary#1');
  });

  it('a transport error or a malformed answer is unavailable', async () => {
    const { transport } = scripted(() => {
      throw new Error('network');
    });
    expect((await settleError(client(transport).get(WEB))).reason).toBe('unavailable');
    const malformed = scripted(() => ({ status: 'ok' }) as MintResult);
    expect((await settleError(client(malformed.transport).get(WEB))).reason).toBe('unavailable');
  });

  it('a whole-call identity refusal denies every token of the call', async () => {
    const { transport } = scripted(() => ({ status: 'identity_rejected' }));
    const tokens = client(transport);
    const [web, ingest] = await settle(
      Promise.all([tokens.get(WEB), tokens.get(INGEST)].map(read => read.catch((error: unknown) => error)))
    );
    expect(web).toMatchObject({ reason: 'denied', deniedReason: 'identity_rejected' });
    expect(ingest).toMatchObject({ reason: 'denied', deniedReason: 'identity_rejected' });
  });
});

describe('denials', () => {
  it('a denied audience does not poison the others, stays denied, and clears on the next successful mint', async () => {
    let allowWeb = false;
    const { transport } = scripted(request => ({
      status: 'ok',
      tokens: request.tokens.map(({ audience, scope }) =>
        audience === 'web' && !allowWeb
          ? { status: 'denied', audience, scope, reason: 'scope_not_allowed' }
          : {
              status: 'issued',
              audience,
              scope,
              token: `${scope}-token`,
              jti: `jti-${audience}`,
              expiresAt: Math.floor(Date.now() / 1000) + 300,
            }
      ),
    }));
    const tokens = client(transport);

    const [web, ingest] = await settle(
      Promise.all([tokens.get(WEB).catch((error: unknown) => error), tokens.get(INGEST)])
    );
    expect(web).toMatchObject({ reason: 'denied', deniedReason: 'scope_not_allowed' });
    expect(ingest).toBe('usage-ingest:sts.canary-token');
    expect(transport).toHaveBeenCalledTimes(1);

    // Sticky: no STS call while the denial is fresh.
    const sticky = await settleError(tokens.get(WEB));
    expect(sticky.deniedReason).toBe('scope_not_allowed');
    expect(transport).toHaveBeenCalledTimes(1);

    // After the recheck interval one read asks again; a grant now clears the denial.
    allowWeb = true;
    await vi.advanceTimersByTimeAsync(DENIED_RECHECK_MS);
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary-token');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('a denial drops a held token', async () => {
    const { transport } = scripted(issueAll(), request => ({
      status: 'ok',
      tokens: request.tokens.map(({ audience, scope }) => ({
        status: 'denied',
        audience,
        scope,
        reason: 'audience_not_allowed',
      })),
    }));
    const tokens = client(transport);
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary#1');
    await vi.advanceTimersByTimeAsync(241_000);
    // The renewal read returns the held token; the denial lands behind it.
    expect(await settle(tokens.get(WEB))).toBe('web:sts.canary#1');
    const error = await settleError(tokens.get(WEB));
    expect(error).toMatchObject({ reason: 'denied', deniedReason: 'audience_not_allowed' });
  });
});
