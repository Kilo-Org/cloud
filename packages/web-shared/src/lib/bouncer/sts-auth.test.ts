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
  BOUNCER_REJECTED_HOLD_MS,
  BOUNCER_TOKEN_WAIT_MS,
  bouncerAuthHeaders,
  bouncerStsTokensEnabled,
  createBouncerAuth,
  installBouncerAuth,
  type BouncerAuth,
  type BouncerAuthCall,
  type BouncerAuthOptions,
  type BouncerCaller,
} from './sts-auth';
import {
  BouncerStsConfigError,
  type BouncerScope,
  type BouncerTokenRead,
} from './sts-auth-contract';

const TOKEN = 'header.payload.signature';
const WEB_SCOPES: readonly BouncerScope[] = [
  'bouncer:decide',
  'bouncer:usage.write',
  'bouncer:signup.decide',
];
const GATEWAY_SCOPES: readonly BouncerScope[] = ['bouncer:decide', 'bouncer:usage.write'];

type Line = Record<string, unknown> & { level: 'info' | 'warn' };

type Harness = {
  auth: BouncerAuth;
  read: jest.MockedFunction<BouncerTokenRead>;
  exchangeReady: jest.MockedFunction<() => Promise<boolean>>;
  loadTransport: jest.MockedFunction<BouncerAuthOptions['loadTransport']>;
  waitUntil: jest.MockedFunction<BouncerAuthOptions['waitUntil']>;
  lines: () => Line[];
  flag: { value: string | undefined };
  /** Added to `Date.now()` (faked or real) to jump past an interval or a hold. */
  clock: { offset: number };
};

function harness(
  caller: BouncerCaller = 'kilocode-app',
  scopes: readonly BouncerScope[] = ['bouncer:decide']
): Harness {
  const read = jest.fn<BouncerTokenRead>();
  const exchangeReady = jest.fn(async () => true);
  const loadTransport = jest.fn<BouncerAuthOptions['loadTransport']>(async () => ({
    read,
    exchangeReady,
  }));
  const waitUntil = jest.fn<BouncerAuthOptions['waitUntil']>();
  const logged: Line[] = [];
  const flag = { value: 'on' as string | undefined };
  const clock = { offset: 0 };
  const auth = createBouncerAuth({
    caller,
    scopes,
    flag: () => flag.value,
    loadTransport,
    waitUntil,
    now: () => Date.now() + clock.offset,
    log: (line, level) => logged.push({ ...(JSON.parse(line) as Record<string, unknown>), level }),
  });
  return { auth, read, exchangeReady, loadTransport, waitUntil, lines: () => logged, flag, clock };
}

const decideCall: BouncerAuthCall = { scope: 'bouncer:decide', wait: true };

/** The counts since the last line: ends the interval and makes one `config` call to write them. */
async function counts(h: Harness): Promise<{ attached: unknown; missed: unknown }> {
  h.clock.offset += BOUNCER_COUNT_LOG_INTERVAL_MS;
  const flag = h.flag.value;
  h.flag.value = 'probe';
  await h.auth.headers({ scope: 'bouncer:decide', wait: false });
  h.flag.value = flag;
  const line = h.lines().at(-1) as unknown as { attached: unknown; missed: unknown };
  const missed = structuredClone(line.missed) as Record<string, Record<string, number>>;
  const decide = missed['bouncer:decide'];
  if (decide.config === 1) delete decide.config;
  else decide.config -= 1;
  if (Object.keys(decide).length === 0) delete missed['bouncer:decide'];
  return { attached: line.attached, missed };
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
      await expect(h.auth.headers(decideCall)).resolves.toEqual({
        'x-kilo-caller': 'kilocode-ai-gateway',
      });
    }
    expect(h.loadTransport).not.toHaveBeenCalled();
    expect(h.lines()).toEqual([]);
  });

  it('keeps the legacy key alone and counts a config miss for an unknown flag value', async () => {
    const h = harness();
    h.flag.value = 'yes';
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    expect(h.loadTransport).not.toHaveBeenCalled();
    expect(h.lines()).toEqual([
      {
        event: 'bouncer_sts_tokens',
        caller: 'kilocode-app',
        attached: {},
        missed: { 'bouncer:decide': { config: 1 } },
        level: 'info',
      },
    ]);
  });

  it('never reads a scope the app is not granted', async () => {
    const h = harness('kilocode-ai-gateway', GATEWAY_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await expect(h.auth.headers({ scope: 'bouncer:signup.decide', wait: true })).resolves.toEqual({
      'x-kilo-caller': 'kilocode-ai-gateway',
    });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:signup.decide': { config: 1 } } });
  });

  it.each(WEB_SCOPES)('sends the %s token as a bearer next to the caller name', async scope => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await expect(h.auth.headers({ scope, wait: true })).resolves.toEqual({
      'x-kilo-caller': 'kilocode-app',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(h.read).toHaveBeenCalledWith({ audience: 'bouncer', scope }, { waitUntil: h.waitUntil });
    expect(h.lines()).toEqual([
      {
        event: 'bouncer_sts_tokens',
        caller: 'kilocode-app',
        attached: { [scope]: 1 },
        missed: {},
        level: 'info',
      },
    ]);
  });

  it.each([
    ['kilocode-app', WEB_SCOPES, ['bouncer:usage.write', 'bouncer:signup.decide']],
    ['kilocode-ai-gateway', GATEWAY_SCOPES, ['bouncer:usage.write']],
  ] as const)(
    'reads the other scopes %s is granted, and only those, on every call',
    async (caller, scopes, siblings) => {
      const h = harness(caller, scopes);
      h.read.mockResolvedValue(TOKEN);
      await h.auth.headers(decideCall);
      await h.auth.headers(decideCall);
      const read = h.read.mock.calls.map(([target]) => target.scope);
      expect(read.filter(scope => scope === 'bouncer:decide')).toHaveLength(2);
      for (const sibling of siblings) {
        expect(read.filter(scope => scope === sibling)).toHaveLength(2);
      }
      expect(new Set(read)).toEqual(new Set(['bouncer:decide', ...siblings]));
      // Each background read is handed to `waitUntil`, so its renewal outlives the response.
      expect(h.waitUntil).toHaveBeenCalledTimes(2 * siblings.length);
    }
  );

  it('loads the transport once for every later call', async () => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    await h.auth.headers({ scope: 'bouncer:usage.write', wait: false });
    await h.auth.headers(decideCall);
    expect(h.loadTransport).toHaveBeenCalledTimes(1);
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
      await expect(h.auth.headers(decideCall)).resolves.toEqual({
        'x-kilo-caller': 'kilocode-app',
      });
      expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { [reason]: 1 } } });
    }
  );

  it('counts a transport that did not load, and loads again on the next call', async () => {
    const h = harness();
    h.loadTransport.mockRejectedValueOnce(new Error('module failed'));
    h.read.mockResolvedValue(TOKEN);
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { load: 1 } } });
    await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(h.loadTransport).toHaveBeenCalledTimes(2);
  });

  it('counts an STS setting that cannot mint as a config miss', async () => {
    const h = harness();
    h.loadTransport.mockRejectedValue(new BouncerStsConfigError('not production'));
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { config: 1 } } });
  });

  it('writes one info line per interval with every count since the last, on the next call', async () => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockImplementation(async target => {
      if (target.scope === 'bouncer:usage.write') throw unavailable();
      return TOKEN;
    });
    await h.auth.headers(decideCall);
    expect(h.lines()).toHaveLength(1);
    await h.auth.headers(decideCall);
    await h.auth.headers({ scope: 'bouncer:signup.decide', wait: true });
    await h.auth.headers({ scope: 'bouncer:usage.write', wait: false });
    await h.auth.headers({ scope: 'bouncer:usage.write', wait: false });
    // Still inside the interval: nothing more written.
    expect(h.lines()).toHaveLength(1);
    await expect(counts(h)).resolves.toEqual({
      attached: { 'bouncer:decide': 1, 'bouncer:signup.decide': 1 },
      missed: { 'bouncer:usage.write': { unavailable: 2 } },
    });
    expect(h.lines().every(line => line.level === 'info')).toBe(true);
  });

  it('never puts a token or an error text in a log line', async () => {
    const h = harness();
    h.read.mockRejectedValueOnce(new Error(`leaked ${TOKEN}`));
    await h.auth.headers(decideCall);
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    await counts(h);
    h.auth.rejected('bouncer:decide');
    for (const line of h.lines()) expect(JSON.stringify(line)).not.toContain(TOKEN);
  });

  it('holds a scope Bouncer refused back for the hold, then sends it again', async () => {
    jest.useFakeTimers();
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    h.auth.rejected('bouncer:decide');
    h.auth.rejected('bouncer:decide');
    expect(h.lines()).toEqual([
      {
        event: 'bouncer_sts_token_rejected',
        caller: 'kilocode-app',
        scope: 'bouncer:decide',
        level: 'warn',
      },
    ]);
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    // Other scopes are not held back.
    await expect(
      h.auth.headers({ scope: 'bouncer:usage.write', wait: false })
    ).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
    h.clock.offset += BOUNCER_REJECTED_HOLD_MS - 1;
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    h.clock.offset += 1;
    await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(h.lines()[1]).toMatchObject({
      event: 'bouncer_sts_tokens',
      missed: { 'bouncer:decide': { rejected: 1 } },
    });
  });

  describe('budgets', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    async function settledAt(promise: Promise<unknown>, ms: number): Promise<boolean> {
      let settled = false;
      void promise.then(() => (settled = true));
      await jest.advanceTimersByTimeAsync(ms);
      return settled;
    }

    it('waits at most the budget for a token, then sends the legacy key and keeps the mint alive', async () => {
      const h = harness();
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      const call = h.auth.headers(decideCall);
      expect(await settledAt(call, BOUNCER_TOKEN_WAIT_MS - 1)).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(call).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { timeout: 1 } } });
      expect(h.waitUntil).toHaveBeenCalledTimes(1);
      mint.resolve(TOKEN);
      await expect(h.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    });

    it('sends a token that arrives inside the budget', async () => {
      const h = harness();
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      const call = h.auth.headers(decideCall);
      await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS - 50);
      mint.resolve(TOKEN);
      await expect(call).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it('does not wait while the exchanged Vercel token is not held, and never counts it', async () => {
      const h = harness();
      h.exchangeReady.mockResolvedValue(false);
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 1; index += 1) {
        const call = h.auth.headers(decideCall);
        expect(await settledAt(call, 1)).toBe(true);
        await expect(call).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      await expect(counts(h)).resolves.toEqual({
        attached: {},
        missed: { 'bouncer:decide': { exchange_pending: BOUNCER_BREAKER_THRESHOLD } },
      });
      expect(h.lines().some(line => line.event === 'bouncer_sts_breaker_open')).toBe(false);
    });

    it('never waits on a route that does not wait', async () => {
      const h = harness();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      const call = h.auth.headers({ scope: 'bouncer:decide', wait: false });
      expect(await settledAt(call, 1)).toBe(true);
      await expect(call).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { not_held: 1 } } });
      expect(h.exchangeReady).not.toHaveBeenCalled();
    });

    it('counts a caller abort as aborted, never as a timeout', async () => {
      const h = harness();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 1; index += 1) {
        const controller = new AbortController();
        const call = h.auth.headers({ ...decideCall, signal: controller.signal });
        await jest.advanceTimersByTimeAsync(100);
        controller.abort();
        await expect(call).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      await expect(counts(h)).resolves.toEqual({
        attached: {},
        missed: { 'bouncer:decide': { aborted: BOUNCER_BREAKER_THRESHOLD } },
      });
      expect(h.lines().some(line => line.event === 'bouncer_sts_breaker_open')).toBe(false);
    });

    it('counts many waits on one running mint once toward the breaker', async () => {
      const h = harness();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      const calls = Array.from({ length: BOUNCER_BREAKER_THRESHOLD * 2 }, () =>
        h.auth.headers(decideCall)
      );
      await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
      await Promise.all(calls);
      expect(h.lines().some(line => line.event === 'bouncer_sts_breaker_open')).toBe(false);
      // One read keeps the running mint alive, not one per waiting call.
      expect(h.waitUntil).toHaveBeenCalledTimes(1);
    });

    it('opens the breaker after the threshold of mints in a row, and closes it only when a read that waited gets its token', async () => {
      const h = harness();
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD; index += 1) {
        const mint = Promise.withResolvers<string>();
        h.read.mockReturnValueOnce(mint.promise);
        const call = h.auth.headers(decideCall);
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
        await call;
        // The mint ends without a token, so the next call's mint is a new one.
        mint.reject(unavailable());
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(h.lines().filter(line => line.event === 'bouncer_sts_breaker_open')).toEqual([
        { event: 'bouncer_sts_breaker_open', caller: 'kilocode-app', level: 'warn' },
      ]);

      // Open: no wait.
      const pending = Promise.withResolvers<string>();
      h.read.mockReturnValueOnce(pending.promise);
      const skipped = h.auth.headers(decideCall);
      expect(await settledAt(skipped, 1)).toBe(true);
      await expect(skipped).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });

      // A held token does not close it; the read that waited for its mint does.
      h.read.mockResolvedValueOnce(TOKEN);
      await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
        authorization: `Bearer ${TOKEN}`,
      });
      expect(h.lines().some(line => line.event === 'bouncer_sts_breaker_closed')).toBe(false);
      pending.resolve(TOKEN);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.lines().at(-1)).toEqual({
        event: 'bouncer_sts_breaker_closed',
        caller: 'kilocode-app',
        level: 'warn',
      });
      await expect(counts(h)).resolves.toMatchObject({
        missed: {
          // The first timeout was written with the instance's first line.
          'bouncer:decide': { timeout: BOUNCER_BREAKER_THRESHOLD - 1, breaker_open: 1 },
        },
      });
    });

    it('does not count a fast failure toward the breaker', async () => {
      const h = harness();
      h.read.mockRejectedValue(unavailable());
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 2; index += 1) {
        await h.auth.headers(decideCall);
      }
      expect(h.lines().some(line => line.event === 'bouncer_sts_breaker_open')).toBe(false);
    });
  });

  describe('with the real token client', () => {
    /** A mint answer whose tokens name their scope and the second they were minted at. */
    function issued(request: MintRequest): MintResult {
      const at = Math.floor(Date.now() / 1000);
      return {
        status: 'ok',
        tokens: request.tokens.map(({ audience, scope }) => ({
          status: 'issued',
          audience,
          scope,
          token: `${scope}@${at}`,
          jti: `jti-${scope}-${at}`,
          expiresAt: at + 300,
        })),
      };
    }

    function realClient(caller: BouncerCaller, scopes: readonly BouncerScope[]) {
      const transport = jest.fn<MintTransport>(async request => issued(request));
      const tokens = createServiceTokens(transport, { attemptTimeoutMs: 30_000 });
      const h = harness(caller, scopes);
      h.loadTransport.mockResolvedValue({
        read: async (target, ctx) => await tokens.get(target, ctx),
        exchangeReady: async () => true,
      });
      const minted = () => transport.mock.calls.flatMap(([request]) => request.tokens);
      return { h, transport, minted };
    }

    it('mints once, serves the held token from memory, and renews it on a read after 80 %', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      const start = Math.floor(Date.now() / 1000);
      const { h, transport } = realClient('kilocode-app', ['bouncer:decide']);

      // The cold read joins the client's 10 ms batch window, inside the 250 ms budget.
      const cold = h.auth.headers(decideCall);
      await jest.advanceTimersByTimeAsync(20);
      await expect(cold).resolves.toMatchObject({
        authorization: `Bearer bouncer:decide@${start}`,
      });
      expect(transport).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60_000);
      await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
        authorization: `Bearer bouncer:decide@${start}`,
      });
      expect(transport).toHaveBeenCalledTimes(1);

      // Past 80 % of 300 s the read still returns the held token and renews in the background.
      await jest.advanceTimersByTimeAsync(181_000);
      await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
        authorization: `Bearer bouncer:decide@${start}`,
      });
      await jest.advanceTimersByTimeAsync(20);
      expect(transport).toHaveBeenCalledTimes(2);
      await expect(h.auth.headers(decideCall)).resolves.not.toMatchObject({
        authorization: `Bearer bouncer:decide@${start}`,
      });
    });

    it('renews a rarely used scope through the traffic of another, and never mints an ungranted one', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      const start = Math.floor(Date.now() / 1000);
      const { h, transport, minted } = realClient('kilocode-ai-gateway', GATEWAY_SCOPES);

      const cold = h.auth.headers(decideCall);
      await jest.advanceTimersByTimeAsync(20);
      await expect(cold).resolves.toMatchObject({
        authorization: `Bearer bouncer:decide@${start}`,
      });
      // Decide every 10 s for 270 s; its calls also read usage.write, which renews it past 80 %.
      for (let index = 0; index < 27; index += 1) {
        await jest.advanceTimersByTimeAsync(10_000);
        await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
          authorization: expect.stringMatching(/^Bearer bouncer:decide@/),
        });
        await jest.advanceTimersByTimeAsync(20);
      }
      await jest.advanceTimersByTimeAsync(9_000);

      // usage.write, first used at about 280 s, past its first token's usable end (270 s).
      const before = transport.mock.calls.length;
      const usage = await h.auth.headers({ scope: 'bouncer:usage.write', wait: false });
      await jest.advanceTimersByTimeAsync(20);
      expect(transport.mock.calls.length).toBe(before);
      const renewedAt = Number(
        /^Bearer bouncer:usage\.write@(\d+)$/.exec(String(usage.authorization))?.[1]
      );
      expect(renewedAt).toBeGreaterThanOrEqual(start + 240);

      expect(minted().some(token => token.scope === 'bouncer:signup.decide')).toBe(false);
      expect(new Set(minted().map(token => token.scope))).toEqual(
        new Set(['bouncer:decide', 'bouncer:usage.write'])
      );
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
    await expect(bouncerAuthHeaders(decideCall)).resolves.toEqual({});
  });

  it('installs the caller name without loading the transport while the flag is unset', async () => {
    installBouncerAuth('kilocode-app', WEB_SCOPES);
    await expect(bouncerAuthHeaders(decideCall)).resolves.toEqual({
      'x-kilo-caller': 'kilocode-app',
    });
  });
});
