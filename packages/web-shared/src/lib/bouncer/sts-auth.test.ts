import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ServiceTokenError,
  createServiceTokens,
  type MintTransport,
} from '@kilocode/service-token-client';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import {
  BOUNCER_ADMISSION_WAIT,
  BOUNCER_AFTER_RESPONSE_WAIT,
  BOUNCER_BREAKER_THRESHOLD,
  BOUNCER_COUNT_LOG_INTERVAL_MS,
  BOUNCER_NO_WAIT,
  BOUNCER_REJECTED_HOLD_MS,
  BOUNCER_SIGNUP_WAIT,
  BOUNCER_STS_ORIGIN,
  BOUNCER_TOKEN_WAIT_MS,
  bouncerAuthHeaders,
  bouncerClientAuthMode,
  createBouncerAuth,
  installBouncerAuth,
  type BouncerAuth,
  type BouncerAuthCall,
  type BouncerAuthOptions,
  type BouncerTokenWait,
} from './sts-auth';
import {
  BOUNCER_APP_SCOPES,
  BouncerStsConfigError,
  type BouncerCaller,
  type BouncerScope,
  type BouncerTokenRead,
  type BouncerTransportHooks,
} from './sts-auth-contract';

const TOKEN = 'header.payload.signature';
const WEB_SCOPES = BOUNCER_APP_SCOPES['kilocode-app'];
const GATEWAY_SCOPES = BOUNCER_APP_SCOPES['kilocode-ai-gateway'];

type Line = Record<string, unknown> & { level: 'info' | 'warn' };

type Harness = {
  auth: BouncerAuth;
  read: jest.MockedFunction<BouncerTokenRead>;
  exchangeReady: jest.MockedFunction<() => Promise<boolean>>;
  skipJitter: jest.MockedFunction<() => void>;
  loadTransport: jest.MockedFunction<BouncerAuthOptions['loadTransport']>;
  waitUntil: jest.MockedFunction<BouncerAuthOptions['waitUntil']>;
  /** The hooks the auth passed to the transport; set once it loaded. */
  hooks: () => BouncerTransportHooks;
  lines: () => Line[];
  flag: { value: string | undefined };
  /** Added to `Date.now()` (faked or real) to jump past an interval or a hold. */
  clock: { offset: number };
};

function harness(
  caller: BouncerCaller = 'kilocode-app',
  scopes: readonly BouncerScope[] = ['bouncer:decide'],
  extra: Partial<BouncerAuthOptions> = {}
): Harness {
  const read = jest.fn<BouncerTokenRead>();
  const exchangeReady = jest.fn(async () => true);
  const skipJitter = jest.fn<() => void>();
  let hooks: BouncerTransportHooks | null = null;
  const loadTransport = jest.fn<BouncerAuthOptions['loadTransport']>(async given => {
    hooks = given;
    return { read, exchangeReady, skipJitter };
  });
  const waitUntil = jest.fn<BouncerAuthOptions['waitUntil']>();
  const logged: Line[] = [];
  const flag = { value: 'dual' as string | undefined };
  const clock = { offset: 0 };
  const auth = createBouncerAuth({
    caller,
    scopes,
    flag: () => flag.value,
    loadTransport,
    waitUntil,
    now: () => Date.now() + clock.offset,
    log: (line, level) => logged.push({ ...(JSON.parse(line) as Record<string, unknown>), level }),
    ...extra,
  });
  return {
    auth,
    read,
    exchangeReady,
    skipJitter,
    loadTransport,
    waitUntil,
    hooks: () => {
      if (hooks === null) throw new Error('the transport has not loaded');
      return hooks;
    },
    lines: () => logged,
    flag,
    clock,
  };
}

/** An admission call (`true`: decide's 250 ms wait) or an outbox delivery (`false`: none). */
function call(
  scope: BouncerScope,
  wait: boolean | BouncerTokenWait,
  signal?: AbortSignal
): BouncerAuthCall {
  const tokenWait =
    wait === true ? BOUNCER_ADMISSION_WAIT : wait === false ? BOUNCER_NO_WAIT : wait;
  return { scope, wait: tokenWait, origin: BOUNCER_STS_ORIGIN, signal };
}

const decideCall = call('bouncer:decide', true);

type Counts = {
  attached: unknown;
  missed: unknown;
  refused: unknown;
  mint: unknown;
  last_mint_age_s: unknown;
};

/** The counts since the last line: ends the interval and makes one `config` call to write them. */
async function counts(h: Harness): Promise<Counts> {
  h.clock.offset += BOUNCER_COUNT_LOG_INTERVAL_MS;
  const flag = h.flag.value;
  h.flag.value = 'probe';
  await h.auth.headers(call('bouncer:decide', false));
  h.flag.value = flag;
  const line = h.lines().at(-1) as unknown as Counts;
  const missed = structuredClone(line.missed) as Record<string, Record<string, number>>;
  const decide = missed['bouncer:decide'];
  if (decide.config === 1) delete decide.config;
  else decide.config -= 1;
  if (Object.keys(decide).length === 0) delete missed['bouncer:decide'];
  return {
    attached: line.attached,
    missed,
    refused: line.refused,
    mint: line.mint,
    last_mint_age_s: line.last_mint_age_s,
  };
}

const invalidToken = { status: 401, reason: 'invalid_token' } as const;
const insufficientScope = { status: 403, reason: 'insufficient_scope' } as const;

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

const breakerOpened = (h: Harness) =>
  h.lines().filter(line => line.event === 'bouncer_sts_breaker_open').length;

afterEach(() => {
  jest.useRealTimers();
});

describe('bouncerClientAuthMode', () => {
  it.each([
    [undefined, 'legacy'],
    ['', 'legacy'],
    ['legacy', 'legacy'],
    ['dual', 'dual'],
    ['sts', 'sts'],
    ['DUAL', 'invalid'],
    ['on', 'invalid'],
    ['true', 'invalid'],
  ] as const)('maps %j to %j', (value, expected) => {
    expect(bouncerClientAuthMode(value)).toBe(expected);
  });
});

describe('createBouncerAuth', () => {
  it('names the caller and loads nothing while the flag is off', async () => {
    const h = harness('kilocode-ai-gateway');
    for (const value of [undefined, '', 'legacy']) {
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
        instance: expect.any(String),
        caller: 'kilocode-app',
        attached: {},
        missed: { 'bouncer:decide': { config: 1 } },
        refused: {},
        mint: { ok: 0, failed: 0 },
        last_mint_age_s: null,
        level: 'info',
      },
    ]);
  });

  it('never reads a scope the app is not granted', async () => {
    const h = harness('kilocode-ai-gateway', GATEWAY_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await expect(h.auth.headers(call('bouncer:signup.decide', true))).resolves.toEqual({
      'x-kilo-caller': 'kilocode-ai-gateway',
    });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:signup.decide': { config: 1 } } });
  });

  it.each(['https://bouncer.example.com', 'http://bouncer.kiloapps.io', 'https://evil.example'])(
    'sends no token to %s, only the legacy key',
    async origin => {
      const h = harness();
      h.read.mockResolvedValue(TOKEN);
      await expect(h.auth.headers({ ...decideCall, origin })).resolves.toEqual({
        'x-kilo-caller': 'kilocode-app',
      });
      expect(h.read).not.toHaveBeenCalled();
      expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { config: 1 } } });
    }
  );

  it.each(WEB_SCOPES)('sends the %s token as a bearer next to the caller name', async scope => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await expect(h.auth.headers(call(scope, true))).resolves.toEqual({
      'x-kilo-caller': 'kilocode-app',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(h.read).toHaveBeenCalledWith({ audience: 'bouncer', scope }, { waitUntil: h.waitUntil });
    expect(h.lines()).toEqual([
      {
        event: 'bouncer_sts_tokens',
        instance: expect.any(String),
        caller: 'kilocode-app',
        attached: { [scope]: 1 },
        missed: {},
        refused: {},
        mint: { ok: 0, failed: 0 },
        last_mint_age_s: null,
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
    }
  );

  it('loads the transport once for every later call', async () => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    await h.auth.headers(call('bouncer:usage.write', false));
    await h.auth.headers(decideCall);
    expect(h.loadTransport).toHaveBeenCalledTimes(1);
  });

  it('starts loading the transport at once when asked to preload, and reads nothing', async () => {
    const h = harness('kilocode-app', WEB_SCOPES, { preload: true });
    await Promise.resolve();
    expect(h.loadTransport).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.exchangeReady).not.toHaveBeenCalled();
    h.read.mockResolvedValue(TOKEN);
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
    await h.auth.headers(call('bouncer:signup.decide', true));
    await h.auth.headers(call('bouncer:usage.write', false));
    await h.auth.headers(call('bouncer:usage.write', false));
    // Still inside the interval: nothing more written.
    expect(h.lines()).toHaveLength(1);
    await expect(counts(h)).resolves.toMatchObject({
      attached: { 'bouncer:decide': 1, 'bouncer:signup.decide': 1 },
      missed: { 'bouncer:usage.write': { unavailable: 2 } },
    });
    expect(h.lines().every(line => line.level === 'info')).toBe(true);
  });

  it('marks every line with one instance id and counts the STS answers the transport reports', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    h.hooks().mint(true);
    h.hooks().mint(false);
    h.hooks().mint(true);
    await jest.advanceTimersByTimeAsync(5_000);
    h.auth.refused('bouncer:decide', invalidToken);
    await expect(counts(h)).resolves.toMatchObject({
      mint: { ok: 2, failed: 1 },
      last_mint_age_s: BOUNCER_COUNT_LOG_INTERVAL_MS / 1000 + 5,
    });
    const instances = new Set(h.lines().map(line => line.instance));
    expect(instances.size).toBe(1);
    expect([...instances][0]).toMatch(/^[0-9a-f-]{36}$/);
    // Another auth is another instance.
    const other = harness();
    other.flag.value = 'probe';
    await other.auth.headers(decideCall);
    expect(other.lines()[0].instance).not.toBe([...instances][0]);
  });

  it('never puts a token or an error text in a log line', async () => {
    const h = harness();
    h.read.mockRejectedValueOnce(new Error(`leaked ${TOKEN}`));
    await h.auth.headers(decideCall);
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    await counts(h);
    h.auth.refused('bouncer:decide', invalidToken);
    for (const line of h.lines()) expect(JSON.stringify(line)).not.toContain(TOKEN);
  });

  it('holds a scope Bouncer refused with 401 back for the hold in dual, then sends it again', async () => {
    jest.useFakeTimers();
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    h.auth.refused('bouncer:decide', invalidToken);
    h.auth.refused('bouncer:decide', invalidToken);
    expect(h.lines().filter(line => line.event === 'bouncer_sts_token_rejected')).toEqual([
      {
        event: 'bouncer_sts_token_rejected',
        instance: expect.any(String),
        caller: 'kilocode-app',
        scope: 'bouncer:decide',
        level: 'warn',
      },
    ]);
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    // Other scopes are not held back.
    await expect(h.auth.headers(call('bouncer:usage.write', false))).resolves.toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    h.clock.offset += BOUNCER_REJECTED_HOLD_MS - 1;
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    h.clock.offset += 1;
    await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    // The first refusal wrote the instance's first line at once; this one has the rest.
    expect(h.lines().at(-1)).toMatchObject({
      event: 'bouncer_sts_tokens',
      missed: { 'bouncer:decide': { rejected: 2 } },
      refused: { 'bouncer:decide': { invalid_token: 1 } },
    });
  });

  it('holds a scope back after a 403 insufficient_scope in dual too', async () => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    h.auth.refused('bouncer:decide', insufficientScope);
    await expect(h.auth.headers(decideCall)).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    expect(h.lines().filter(line => line.event === 'bouncer_sts_token_rejected')).toHaveLength(1);
    await expect(counts(h)).resolves.toMatchObject({
      missed: { 'bouncer:decide': { rejected: 1 } },
      refused: { 'bouncer:decide': { insufficient_scope: 1 } },
    });
  });

  it('counts a refused legacy key in dual but holds the token nothing back', async () => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    h.auth.refused('bouncer:decide', { status: 401, reason: 'legacy_key' });
    h.auth.refused('bouncer:decide', { status: 403, reason: 'http_403' });
    await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(h.lines().some(line => line.event === 'bouncer_sts_token_rejected')).toBe(false);
    await expect(counts(h)).resolves.toMatchObject({
      refused: { 'bouncer:decide': { legacy_key: 1, http_403: 1 } },
    });
  });

  it('starts no read at creation, in any mode', async () => {
    for (const mode of ['dual', 'sts']) {
      const h = harness('kilocode-app', WEB_SCOPES, { flag: () => mode, preload: true });
      await new Promise(resolve => setImmediate(resolve));
      expect(h.read).not.toHaveBeenCalled();
    }
  });

  it('in sts never holds a refused scope back and counts each refusal under its reason', async () => {
    const h = harness('kilocode-app', WEB_SCOPES);
    h.flag.value = 'sts';
    expect(h.auth.mode()).toBe('sts');
    h.read.mockResolvedValue(TOKEN);
    await h.auth.headers(decideCall);
    h.auth.refused('bouncer:decide', invalidToken);
    h.auth.refused('bouncer:decide', insufficientScope);
    await expect(h.auth.headers(decideCall)).resolves.toEqual({
      'x-kilo-caller': 'kilocode-app',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(h.lines().some(line => line.event === 'bouncer_sts_token_rejected')).toBe(false);
    await expect(counts(h)).resolves.toMatchObject({
      attached: { 'bouncer:decide': 1 },
      missed: {},
      refused: { 'bouncer:decide': { invalid_token: 1, insufficient_scope: 1 } },
    });
  });

  it('ignores a refusal of a scope the app is not granted', async () => {
    const h = harness('kilocode-ai-gateway', GATEWAY_SCOPES);
    h.auth.refused('bouncer:signup.decide', invalidToken);
    expect(h.lines()).toEqual([]);
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
      const pending = h.auth.headers(decideCall);
      expect(await settledAt(pending, BOUNCER_TOKEN_WAIT_MS - 1)).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { timeout: 1 } } });
      expect(h.waitUntil).toHaveBeenCalledTimes(1);
      mint.resolve(TOKEN);
      await expect(h.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    });

    it('sends a token that arrives inside the budget', async () => {
      const h = harness();
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      const pending = h.auth.headers(decideCall);
      await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS - 50);
      mint.resolve(TOKEN);
      await expect(pending).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it('reads each scope once per mint: one read and one waitUntil per scope for 20 calls', async () => {
      const h = harness('kilocode-app', WEB_SCOPES);
      const mints = new Map<BouncerScope, PromiseWithResolvers<string>>();
      h.read.mockImplementation(async target => {
        const mint = Promise.withResolvers<string>();
        mints.set(target.scope, mint);
        return await mint.promise;
      });
      const calls = Array.from({ length: 20 }, (_, index) =>
        h.auth.headers(call(WEB_SCOPES[index % WEB_SCOPES.length], true))
      );
      await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
      await Promise.all(calls);
      expect(h.read).toHaveBeenCalledTimes(WEB_SCOPES.length);
      expect(h.waitUntil).toHaveBeenCalledTimes(WEB_SCOPES.length);
      // 20 waits ran out together: one count, far below the threshold.
      expect(breakerOpened(h)).toBe(0);
      // Sibling reads start as each read settles; they find the token at once.
      h.read.mockResolvedValue(TOKEN);
      for (const mint of mints.values()) mint.resolve(TOKEN);
      await jest.advanceTimersByTimeAsync(0);
      await expect(h.auth.headers(decideCall)).resolves.toMatchObject({
        authorization: `Bearer ${TOKEN}`,
      });
    });

    it('does not wait while the exchanged Vercel token is not held, and never counts it', async () => {
      const h = harness();
      h.exchangeReady.mockResolvedValue(false);
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 1; index += 1) {
        const pending = h.auth.headers(decideCall);
        expect(await settledAt(pending, 1)).toBe(true);
        await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      await expect(counts(h)).resolves.toMatchObject({
        missed: { 'bouncer:decide': { exchange_pending: BOUNCER_BREAKER_THRESHOLD } },
      });
      expect(breakerOpened(h)).toBe(0);
      // `dual` keeps the first-mint jitter.
      expect(h.skipJitter).not.toHaveBeenCalled();
    });

    it('in sts waits for a cold mint that lands inside the budget and sends its token', async () => {
      const h = harness();
      h.flag.value = 'sts';
      h.exchangeReady.mockResolvedValue(false);
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      const pending = h.auth.headers(decideCall);
      expect(await settledAt(pending, 100)).toBe(false);
      mint.resolve(TOKEN);
      await expect(pending).resolves.toEqual({
        'x-kilo-caller': 'kilocode-app',
        authorization: `Bearer ${TOKEN}`,
      });
      expect(h.exchangeReady).not.toHaveBeenCalled();
      // The mint this call waits for skips the first-mint jitter.
      expect(h.skipJitter).toHaveBeenCalledTimes(1);
    });

    it('in sts asks no jitter skip for a held token or a route that never waits', async () => {
      const h = harness('kilocode-app', WEB_SCOPES);
      h.flag.value = 'sts';
      h.read.mockResolvedValue(TOKEN);
      const held = h.auth.headers(decideCall);
      expect(await settledAt(held, 1)).toBe(true);
      await expect(held).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      const noWait = h.auth.headers(call('bouncer:usage.write', false));
      expect(await settledAt(noWait, 1)).toBe(true);
      expect(h.skipJitter).not.toHaveBeenCalled();
    });

    it('in sts ends a cold wait at the budget as exchange_pending, never moving the breaker', async () => {
      const h = harness();
      h.flag.value = 'sts';
      h.exchangeReady.mockResolvedValue(false);
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 1; index += 1) {
        const pending = h.auth.headers(decideCall);
        expect(await settledAt(pending, BOUNCER_TOKEN_WAIT_MS - 1)).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      await expect(counts(h)).resolves.toMatchObject({
        missed: { 'bouncer:decide': { exchange_pending: BOUNCER_BREAKER_THRESHOLD } },
      });
      expect(breakerOpened(h)).toBe(0);
    });

    it('in sts counts a timeout with the exchange held toward the breaker', async () => {
      const h = harness();
      h.flag.value = 'sts';
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD; index += 1) {
        const pending = h.auth.headers(decideCall);
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
        await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { timeout: 1 } } });
      expect(breakerOpened(h)).toBe(1);
    });

    it('in sts waits for a 1,000 ms signup mint and counts no timeout', async () => {
      const h = harness('kilocode-app', WEB_SCOPES);
      h.flag.value = 'sts';
      const mint = Promise.withResolvers<string>();
      h.read.mockReturnValue(mint.promise);
      const pending = h.auth.headers(call('bouncer:signup.decide', BOUNCER_SIGNUP_WAIT));
      expect(await settledAt(pending, 1_000)).toBe(false);
      mint.resolve(TOKEN);
      await expect(pending).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect((await counts(h)).missed).toEqual({});
      expect(breakerOpened(h)).toBe(0);
    });

    it('in dual a signup waits only the 250 ms decide budget', async () => {
      const h = harness('kilocode-app', WEB_SCOPES);
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      const pending = h.auth.headers(call('bouncer:signup.decide', BOUNCER_SIGNUP_WAIT));
      expect(await settledAt(pending, BOUNCER_TOKEN_WAIT_MS - 1)).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
    });

    it('in sts a call after the response waits for a renewal mint, never moving the breaker', async () => {
      const h = harness('kilocode-app', WEB_SCOPES);
      h.flag.value = 'sts';
      const renewal = Promise.withResolvers<string>();
      h.read.mockReturnValue(renewal.promise);
      const pending = h.auth.headers(call('bouncer:usage.write', BOUNCER_AFTER_RESPONSE_WAIT));
      expect(await settledAt(pending, 100)).toBe(false);
      renewal.resolve(TOKEN);
      await expect(pending).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
      // No jitter skip: it is not an admission call.
      expect(h.skipJitter).not.toHaveBeenCalled();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 1; index += 1) {
        const late = h.auth.headers(call('bouncer:usage.write', BOUNCER_AFTER_RESPONSE_WAIT));
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
        await expect(late).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      expect(breakerOpened(h)).toBe(0);
    });

    it('in sts an outbox delivery never waits, nor does a call after the response in dual', async () => {
      for (const [mode, wait] of [
        ['sts', BOUNCER_NO_WAIT],
        ['dual', BOUNCER_AFTER_RESPONSE_WAIT],
      ] as const) {
        const h = harness('kilocode-app', WEB_SCOPES);
        h.flag.value = mode;
        h.read.mockReturnValue(Promise.withResolvers<string>().promise);
        const pending = h.auth.headers(call('bouncer:usage.write', wait));
        expect(await settledAt(pending, 1)).toBe(true);
        await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
    });

    it('counts a readiness check that outlasts the wait as readiness_timeout, toward the breaker', async () => {
      const h = harness();
      h.exchangeReady.mockReturnValue(Promise.withResolvers<boolean>().promise);
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD; index += 1) {
        const pending = h.auth.headers(decideCall);
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
        await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      expect(h.lines()[0]).toMatchObject({
        missed: { 'bouncer:decide': { readiness_timeout: 1 } },
      });
      expect(breakerOpened(h)).toBe(1);
    });

    it('never waits on a route that does not wait', async () => {
      const h = harness();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      const pending = h.auth.headers(call('bouncer:decide', false));
      expect(await settledAt(pending, 1)).toBe(true);
      await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      expect(h.lines()[0]).toMatchObject({ missed: { 'bouncer:decide': { not_held: 1 } } });
      expect(h.exchangeReady).not.toHaveBeenCalled();
    });

    it('counts a caller abort as aborted, never as a timeout', async () => {
      const h = harness();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 1; index += 1) {
        const controller = new AbortController();
        const pending = h.auth.headers(call('bouncer:decide', true, controller.signal));
        await jest.advanceTimersByTimeAsync(100);
        controller.abort();
        await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
      }
      await expect(counts(h)).resolves.toMatchObject({
        missed: { 'bouncer:decide': { aborted: BOUNCER_BREAKER_THRESHOLD } },
      });
      expect(breakerOpened(h)).toBe(0);
    });

    it('opens the breaker after about 2.5 s of continuous timeouts against a hung STS', async () => {
      const h = harness();
      h.read.mockReturnValue(Promise.withResolvers<string>().promise);
      for (let index = 1; index <= BOUNCER_BREAKER_THRESHOLD; index += 1) {
        const pending = h.auth.headers(decideCall);
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
        await pending;
        expect(breakerOpened(h)).toBe(index === BOUNCER_BREAKER_THRESHOLD ? 1 : 0);
      }
      // Open: no wait at all.
      const skipped = h.auth.headers(decideCall);
      expect(await settledAt(skipped, 1)).toBe(true);
      await expect(counts(h)).resolves.toMatchObject({
        missed: { 'bouncer:decide': { breaker_open: 1 } },
      });
    });

    it('opens the breaker against a slow STS whose tokens arrive after the wait, and closes on its next mint', async () => {
      const h = harness();
      // Each mint answers 300 ms after it starts, 50 ms after the call stopped waiting.
      h.read.mockImplementation(async () => {
        const mint = Promise.withResolvers<string>();
        setTimeout(() => mint.resolve(TOKEN), 300);
        return await mint.promise;
      });
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD; index += 1) {
        const pending = h.auth.headers(decideCall);
        await jest.advanceTimersByTimeAsync(300);
        await expect(pending).resolves.toEqual({ 'x-kilo-caller': 'kilocode-app' });
      }
      expect(breakerOpened(h)).toBe(1);
      h.hooks().mint(true);
      expect(h.lines().at(-1)).toMatchObject({
        event: 'bouncer_sts_breaker_closed',
        level: 'warn',
      });
    });

    it('resets the count when a token arrives within the wait', async () => {
      const h = harness();
      let next = Promise.withResolvers<string>();
      h.read.mockImplementation(async () => await next.promise);
      async function timedOutCall(): Promise<void> {
        next = Promise.withResolvers<string>();
        const pending = h.auth.headers(decideCall);
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
        await pending;
        // That mint ends without a token, so the next call starts a new one.
        next.reject(unavailable());
        await jest.advanceTimersByTimeAsync(0);
      }
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD - 1; index += 1) await timedOutCall();
      next = Promise.withResolvers<string>();
      const inTime = h.auth.headers(decideCall);
      await jest.advanceTimersByTimeAsync(100);
      next.resolve(TOKEN);
      await expect(inTime).resolves.toMatchObject({ authorization: `Bearer ${TOKEN}` });
      await jest.advanceTimersByTimeAsync(0);
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD - 1; index += 1) await timedOutCall();
      expect(breakerOpened(h)).toBe(0);
    });

    it('does not count a fast failure toward the breaker', async () => {
      const h = harness();
      h.read.mockRejectedValue(unavailable());
      for (let index = 0; index < BOUNCER_BREAKER_THRESHOLD + 2; index += 1) {
        await h.auth.headers(decideCall);
        await jest.advanceTimersByTimeAsync(BOUNCER_TOKEN_WAIT_MS);
      }
      expect(breakerOpened(h)).toBe(0);
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
        skipJitter: () => {},
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
      const usage = await h.auth.headers(call('bouncer:usage.write', false));
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
    delete process.env.BOUNCER_CLIENT_AUTH;
  });

  it('sends nothing extra in a process that installed nothing', async () => {
    globalThis.__kilocodeBouncerAuth = undefined;
    await expect(bouncerAuthHeaders(decideCall)).resolves.toEqual({});
  });

  it('installs the caller name without loading the transport while the flag is unset', async () => {
    installBouncerAuth('kilocode-app');
    await expect(bouncerAuthHeaders(decideCall)).resolves.toEqual({
      'x-kilo-caller': 'kilocode-app',
    });
  });
});
