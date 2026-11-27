import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ServiceTokenError,
  createServiceTokens,
  type MintTransport,
} from '@kilocode/service-token-client';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import {
  BOUNCER_BREAKER_THRESHOLD,
  BOUNCER_COUNT_LOG_INTERVAL_MS,
  BOUNCER_TOKEN_WAIT_MS,
  bouncerAuthHeaders,
  bouncerStsTokensEnabled,
  createBouncerAuth,
  installBouncerAuth,
  type BouncerAuth,
  type BouncerAuthOptions,
} from './sts-auth';
import { BouncerStsConfigError, type BouncerTokenRead } from './sts-auth-contract';

const TOKEN = 'header.payload.signature';

type Harness = {
  auth: BouncerAuth;
  read: jest.MockedFunction<BouncerTokenRead>;
  loadTokens: jest.MockedFunction<BouncerAuthOptions['loadTokens']>;
  waitUntil: jest.MockedFunction<BouncerAuthOptions['waitUntil']>;
  lines: () => Record<string, unknown>[];
  flag: { value: string | undefined };
  clock: { now: number };
};

function harness(caller: 'kilocode-app' | 'kilocode-ai-gateway' = 'kilocode-app'): Harness {
  const read = jest.fn<BouncerTokenRead>();
  const loadTokens = jest.fn<BouncerAuthOptions['loadTokens']>(async () => read);
  const waitUntil = jest.fn<BouncerAuthOptions['waitUntil']>();
  const logged: string[] = [];
  const flag = { value: 'on' as string | undefined };
  const clock = { now: 1_000_000 };
  const auth = createBouncerAuth({
    caller,
    flag: () => flag.value,
    loadTokens,
    waitUntil,
    now: () => clock.now,
    log: line => logged.push(line),
  });
  return {
    auth,
    read,
    loadTokens,
    waitUntil,
    lines: () => logged.map(line => JSON.parse(line) as Record<string, unknown>),
    flag,
    clock,
  };
}

function denied(): ServiceTokenError {
  return new ServiceTokenError(
    { reason: 'denied', deniedReason: 'audience_not_allowed' },
    { audience: 'bouncer', scope: 'bouncer:decide' }
  );
}

function unavailable(): ServiceTokenError {
  return new ServiceTokenError(
    { reason: 'unavailable', retryAfterSeconds: 2 },
    { audience: 'bouncer', scope: 'bouncer:decide' }
  );
}

afterEach(() => {
  jest.useRealTimers();
});

describe('bouncerStsTokensEnabled', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['off', false],
    ['on', true],
    ['ON', 'invalid'],
    ['true', 'invalid'],
    ['1', 'invalid'],
  ] as const)('maps %j to %j', (value, expected) => {
    expect(bouncerStsTokensEnabled(value)).toBe(expected);
  });
});

describe('createBouncerAuth', () => {
  it('names the caller and loads nothing while the flag is off', async () => {
    const h = harness('kilocode-ai-gateway');
    for (const value of [undefined, '', 'off']) {
      h.flag.value = value;
      await expect(h.auth('bouncer:decide')).resolves.toEqual({
        'x-kilo-caller': 'kilocode-ai-gateway',
      });
    }
    expect(h.loadTokens).not.toHaveBeenCalled();
    expect(h.lines()).toEqual([]);
  });

  it('keeps the legacy key alone and counts a config miss for an unknown flag value', async () => {
    const h = harness();
    h.flag.value = 'yes';
    await expect(h.auth('bouncer:decide')).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    expect(h.loadTokens).not.toHaveBeenCalled();
    expect(h.lines()).toEqual([
      {
        event: 'bouncer_sts_token_missed',
        caller: 'kilocode-app',
        reason: 'config',
        scope: 'bouncer:decide',
        count: 1,
      },
    ]);
  });

  it.each(['bouncer:decide', 'bouncer:usage.write', 'bouncer:signup.decide'] as const)(
    'sends the %s token as a bearer next to the caller name',
    async scope => {
      const h = harness();
      h.read.mockResolvedValue(TOKEN);
      await expect(h.auth(scope)).resolves.toEqual({
        'x-kilo-caller': 'kilocode-app',
        authorization: `Bearer ${TOKEN}`,
      });
      expect(h.read).toHaveBeenCalledWith(
        { audience: 'bouncer', scope },
        { waitUntil: h.waitUntil }
      );
      expect(h.lines()).toEqual([
        { event: 'bouncer_sts_token_attached', caller: 'kilocode-app', scope, count: 1 },
      ]);
    }
  );

  it('loads the token client once for every later call', async () => {
    const h = harness();
    h.read.mockResolvedValue(TOKEN);
    await h.auth('bouncer:decide');
    await h.auth('bouncer:usage.write');
    await h.auth('bouncer:decide');
    expect(h.loadTokens).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['denied', denied],
    ['unavailable', unavailable],
    ['unavailable', () => new Error('anything else')],
  ] as const)(
    'falls back to the legacy key on a %s mint failure and counts it',
    async (reason, error) => {
      const h = harness();
      h.read.mockRejectedValue(error());
      await expect(h.auth('bouncer:decide')).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.lines()).toEqual([
        {
          event: 'bouncer_sts_token_missed',
          caller: 'kilocode-app',
          reason,
          scope: 'bouncer:decide',
          count: 1,
        },
      ]);
    }
  );

  it('counts a transport that did not load, and loads again on the next call', async () => {
    const h = harness();
    h.loadTokens.mockRejectedValueOnce(new Error('module failed'));
    h.read.mockResolvedValue(TOKEN);
    await expect(h.auth('bouncer:decide')).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    expect(h.lines()).toMatchObject([{ reason: 'load' }]);
    await expect(h.auth('bouncer:decide')).resolves.toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(h.loadTokens).toHaveBeenCalledTimes(2);
  });

  it('counts an STS setting that cannot mint as a config miss', async () => {
    const h = harness();
    h.loadTokens.mockRejectedValue(new BouncerStsConfigError('wrong issuer'));
    await expect(h.auth('bouncer:usage.write')).resolves.toEqual({
      'x-kilo-caller': 'kilocode-app',
    });
    expect(h.lines()).toMatchObject([{ reason: 'config', scope: 'bouncer:usage.write' }]);
  });

  it('logs one miss line per reason and scope per interval, with the count since the last', async () => {
    const h = harness();
    h.read.mockRejectedValue(unavailable());
    await h.auth('bouncer:decide');
    await h.auth('bouncer:decide');
    await h.auth('bouncer:decide');
    await h.auth('bouncer:usage.write');
    expect(h.lines()).toMatchObject([
      { reason: 'unavailable', scope: 'bouncer:decide', count: 1 },
      { reason: 'unavailable', scope: 'bouncer:usage.write', count: 1 },
    ]);
    h.clock.now += BOUNCER_COUNT_LOG_INTERVAL_MS;
    await h.auth('bouncer:decide');
    expect(h.lines()[2]).toMatchObject({
      reason: 'unavailable',
      scope: 'bouncer:decide',
      count: 3,
    });
  });

  it('logs one attached line per scope per interval, with the count since the last', async () => {
    const h = harness();
    h.read.mockResolvedValue(TOKEN);
    await h.auth('bouncer:decide');
    await h.auth('bouncer:decide');
    await h.auth('bouncer:decide');
    await h.auth('bouncer:usage.write');
    expect(h.lines()).toEqual([
      {
        event: 'bouncer_sts_token_attached',
        caller: 'kilocode-app',
        scope: 'bouncer:decide',
        count: 1,
      },
      {
        event: 'bouncer_sts_token_attached',
        caller: 'kilocode-app',
        scope: 'bouncer:usage.write',
        count: 1,
      },
    ]);
    h.clock.now += BOUNCER_COUNT_LOG_INTERVAL_MS;
    await h.auth('bouncer:decide');
    expect(h.lines()[2]).toEqual({
      event: 'bouncer_sts_token_attached',
      caller: 'kilocode-app',
      scope: 'bouncer:decide',
      count: 3,
    });
    // A call without a token is a miss, never an attach.
    h.read.mockRejectedValue(unavailable());
    h.clock.now += BOUNCER_COUNT_LOG_INTERVAL_MS;
    await h.auth('bouncer:decide');
    expect(h.lines()[3]).toMatchObject({
      event: 'bouncer_sts_token_missed',
      reason: 'unavailable',
    });
    expect(h.lines()).toHaveLength(4);
  });

  it('never puts a token or an error text in a log line', async () => {
    const h = harness();
    h.read.mockRejectedValueOnce(new Error(`leaked ${TOKEN}`));
    await h.auth('bouncer:decide');
    h.read.mockResolvedValue(TOKEN);
    await h.auth('bouncer:decide');
    for (const line of h.lines()) expect(JSON.stringify(line)).not.toContain(TOKEN);
  });

  describe('budgets', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('waits at most the budget for an admission token, then sends the legacy key and keeps the mint alive', async () => {
      const h = harness();
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      let settled = false;
      const call = h.auth('bouncer:decide').then(headers => {
        settled = true;
        return headers;
      });
      await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(call).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.waitUntil).toHaveBeenCalledTimes(1);
      expect(h.lines()).toMatchObject([{ reason: 'timeout', scope: 'bouncer:decide' }]);
      mint.resolve(TOKEN);
      await expect(h.waitUntil.mock.calls[0][0]).resolves.toBe(TOKEN);
    });

    it('sends a token that arrives inside the budget', async () => {
      const h = harness();
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      const call = h.auth('bouncer:signup.decide');
      await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS - 50);
      mint.resolve(TOKEN);
      await expect(call).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it('never waits for a usage token it does not hold', async () => {
      const h = harness();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      const call = h.auth('bouncer:usage.write');
      await jest.advanceTimersByTimeAsync(0);
      await expect(call).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.lines()).toMatchObject([{ reason: 'not_held', scope: 'bouncer:usage.write' }]);
      expect(h.waitUntil).toHaveBeenCalledTimes(1);
    });

    it('opens the breaker after the threshold of timed-out waits, and closes it on the next mint', async () => {
      const h = harness();
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD; index += 1) {
        const call = h.auth('bouncer:decide');
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
        await call;
      }
      expect(h.lines().filter(line => line.event === 'bouncer_sts_breaker_open')).toHaveLength(1);

      // Open: an admission call no longer waits.
      const skipped = h.auth('bouncer:decide');
      await jest.advanceTimersByTimeAsync(0);
      await expect(skipped).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.lines().at(-1)).toMatchObject({ reason: 'breaker_open' });

      // A mint that lands closes it, and the next call waits again and gets its token.
      mint.resolve(TOKEN);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.lines().at(-1)).toMatchObject({ event: 'bouncer_sts_breaker_closed' });
      h.read.mockResolvedValue(TOKEN);
      await expect(h.auth('bouncer:decide')).resolves.toMatchObject({
        authorization: `Bearer ${TOKEN}`,
      });
    });

    it('does not count a fast failure toward the breaker', async () => {
      const h = harness();
      h.read.mockRejectedValue(unavailable());
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 2; index += 1) {
        await h.auth('bouncer:decide');
      }
      expect(h.lines().some(line => line.event === 'bouncer_sts_breaker_open')).toBe(false);
    });
  });

  describe('with the real token client', () => {
    function issued(request: MintRequest, expiresAt: number, serial: number): MintResult {
      return {
        status: 'ok',
        tokens: request.tokens.map(({ audience, scope }) => ({
          status: 'issued',
          audience,
          scope,
          token: `${scope}-${serial}`,
          jti: `jti-${serial}`,
          expiresAt,
        })),
      };
    }

    it('mints once, serves the held token from memory, and renews it in the background at 80 %', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      let serial = 0;
      const transport = jest.fn<MintTransport>(async request => {
        serial += 1;
        return issued(request, Math.floor(Date.now() / 1000) + 300, serial);
      });
      const tokens = createServiceTokens(transport, { attemptTimeoutMs: 30_000 });
      const h = harness();
      h.loadTokens.mockResolvedValue((target, ctx) => tokens.get(target, ctx));

      // The cold read joins the client's 10 ms batch window, inside the 250 ms budget.
      const cold = h.auth('bouncer:decide');
      await jest.advanceTimersByTimeAsync(20);
      await expect(cold).resolves.toMatchObject({ authorization: 'Bearer bouncer:decide-1' });
      expect(transport).toHaveBeenCalledTimes(1);

      // Warm: no STS call, the same token.
      await jest.advanceTimersByTimeAsync(60_000);
      await expect(h.auth('bouncer:decide')).resolves.toMatchObject({
        authorization: 'Bearer bouncer:decide-1',
      });
      expect(transport).toHaveBeenCalledTimes(1);

      // Past 80 % of 300 s the read still returns the held token and renews in the background.
      await jest.advanceTimersByTimeAsync(181_000);
      await expect(h.auth('bouncer:decide')).resolves.toMatchObject({
        authorization: 'Bearer bouncer:decide-1',
      });
      await jest.advanceTimersByTimeAsync(20);
      expect(transport).toHaveBeenCalledTimes(2);
      await expect(h.auth('bouncer:decide')).resolves.toMatchObject({
        authorization: 'Bearer bouncer:decide-2',
      });
      // Four calls with a token on one instance clock: one attached line, no miss.
      expect(h.lines()).toEqual([
        {
          event: 'bouncer_sts_token_attached',
          caller: 'kilocode-app',
          scope: 'bouncer:decide',
          count: 1,
        },
      ]);
    });
  });
});

describe('installBouncerAuth', () => {
  afterEach(() => {
    globalThis.__kilocodeBouncerAuth = undefined;
    delete process.env.BOUNCER_STS_TOKENS;
  });

  it('sends nothing extra in a process that installed nothing', async () => {
    globalThis.__kilocodeBouncerAuth = undefined;
    await expect(bouncerAuthHeaders('bouncer:decide')).resolves.toEqual({});
  });

  it('installs the caller name without loading the transport while the flag is unset', async () => {
    installBouncerAuth('kilocode-app');
    await expect(bouncerAuthHeaders('bouncer:decide')).resolves.toEqual({
      'x-kilo-caller': 'kilocode-app',
    });
  });
});
