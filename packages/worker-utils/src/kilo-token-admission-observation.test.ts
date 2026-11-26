import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SignJWT } from 'jose';
import {
  KILO_TOKEN_ADMISSION_CONTROL_SUBJECT,
  KILO_TOKEN_ADMISSION_OBSERVATION_FLAG,
  audienceSetLabel,
  parseAdmissionControlSubject,
} from './kilo-token-admission-observation';
import {
  signModernKiloToken,
  verifyKiloTokenForPolicy,
  verifyKiloTokenForResource,
} from './kilo-token-policy';
import { verifyKiloToken } from './kilo-token';

const SECRET = 'synthetic-admission-test-secret-at-least-32-chars';
const SUBJECT = 'synthetic-bot-subject';
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const API_POLICY = { audience: 'kilo-api', mode: 'allow-legacy' } as const;
const BOTH_AUDIENCES = ['kilo-api', 'kilo-gateway'];

async function legacyToken(
  claims: Record<string, unknown>,
  options: { secret?: string; expiresInSeconds?: number } = {}
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ version: 3, kiloUserId: SUBJECT, apiTokenPepper: 'pepper', ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

let log: MockInstance<typeof console.log>;

function lines() {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv(KILO_TOKEN_ADMISSION_OBSERVATION_FLAG, 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('audienceSetLabel', () => {
  it.each([
    [undefined, 'none'],
    ['kilo-api', 'kilo-api'],
    ['partner', 'other'],
    [['kilo-gateway', 'kilo-api'], 'kilo-api+kilo-gateway'],
    [['session-ingest', 'partner', 'kilo-api', 7], 'kilo-api+session-ingest+other'],
    [Array.from({ length: 9 }, (_, i) => (i === 8 ? 'kilo-api' : `partner-${i}`)), 'other+more'],
  ])('labels %j as %s', (aud, label) => {
    expect(audienceSetLabel(aud)).toBe(label);
  });
});

describe('shared verifier admission observation', () => {
  it('writes nothing while the flag is not exactly true', async () => {
    vi.stubEnv(KILO_TOKEN_ADMISSION_OBSERVATION_FLAG, 'TRUE');

    await verifyKiloTokenForResource(
      await legacyToken({ aud: BOTH_AUDIENCES }),
      SECRET,
      API_POLICY
    );

    expect(log).not.toHaveBeenCalled();
  });

  it('reports each accepted multi-audience token with bounded labels only', async () => {
    const token = await legacyToken({
      aud: [...BOTH_AUDIENCES, 'partner-audience'],
      tokenSource: 'internal-bot',
      organizationId: ORGANIZATION_ID,
    });

    await verifyKiloTokenForResource(token, SECRET, API_POLICY);
    await verifyKiloTokenForResource(token, SECRET, API_POLICY);

    const line = {
      event: 'kilo_token_admission',
      v: 1,
      boundary: 'resource',
      policy_audience: 'kilo-api',
      outcome: 'admitted',
      multi: true,
      control: false,
      aud_set: 'kilo-api+kilo-gateway+other',
      issuer: 'internal_bot',
    };
    expect(lines()).toEqual([line, line]);
    const written = log.mock.calls.map(([output]) => String(output)).join('\n');
    for (const forbidden of [token, SUBJECT, ORGANIZATION_ID, 'partner-audience']) {
      expect(written).not.toContain(forbidden);
    }
  });

  it('reports a modern dual-audience bot token on the policy verifier', async () => {
    const { token } = await signModernKiloToken({
      userId: SUBJECT,
      secret: SECRET,
      expiresInSeconds: 3600,
      pepper: 'pepper',
      audience: BOTH_AUDIENCES,
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      extra: {
        tokenSource: 'internal-bot',
        organizationId: ORGANIZATION_ID,
        organizationRole: 'member',
      },
    });

    await verifyKiloTokenForPolicy(token, SECRET, { audience: 'kilo-gateway', mode: 'required' });

    expect(lines()).toEqual([
      expect.objectContaining({
        boundary: 'policy',
        policy_audience: 'kilo-gateway',
        aud_set: 'kilo-api+kilo-gateway',
        issuer: 'internal_bot',
      }),
    ]);
  });

  it('reports the exact-audience verifier, which accepts any array naming its audience', async () => {
    await verifyKiloToken(await legacyToken({ aud: ['session-ingest', 'kilo-api'] }), SECRET, {
      audience: 'session-ingest',
    });

    expect(lines()).toEqual([
      expect.objectContaining({ boundary: 'exact_audience', policy_audience: 'session-ingest' }),
    ]);
  });

  it.each([
    ['repeated names', ['session-ingest', 'session-ingest'], 'session-ingest'],
    ['unlisted names', ['session-ingest', 'partner-a', 'partner-b'], 'session-ingest+other'],
  ])('marks a multi-audience token whose %s collapse in aud_set', async (_label, aud, set) => {
    await verifyKiloToken(await legacyToken({ aud }), SECRET, { audience: 'session-ingest' });

    expect(lines()).toEqual([expect.objectContaining({ multi: true, aud_set: set })]);
  });

  it('writes nothing for accepted single-audience and audience-less tokens', async () => {
    await verifyKiloTokenForResource(await legacyToken({ aud: 'kilo-api' }), SECRET, API_POLICY);
    await verifyKiloTokenForResource(await legacyToken({}), SECRET, API_POLICY);
    await verifyKiloTokenForResource(await legacyToken({ aud: ['kilo-api'] }), SECRET, API_POLICY);

    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a forged signature',
      () =>
        legacyToken({ aud: BOTH_AUDIENCES }, { secret: 'forged-secret-at-least-32-characters' }),
    ],
    ['an expired token', () => legacyToken({ aud: BOTH_AUDIENCES }, { expiresInSeconds: -60 })],
    [
      'an array without the policy audience',
      () => legacyToken({ aud: ['kilo-gateway', 'session-ingest'] }),
    ],
    ['an outdated version', () => legacyToken({ aud: BOTH_AUDIENCES, version: 2 })],
  ])('writes nothing when it refuses %s', async (_label, mint) => {
    const token = await mint();

    await expect(verifyKiloTokenForResource(token, SECRET, API_POLICY)).rejects.toThrow();
    await expect(verifyKiloTokenForPolicy(token, SECRET, API_POLICY)).rejects.toThrow();
    await expect(verifyKiloToken(token, SECRET, { audience: 'kilo-api' })).rejects.toThrow();

    expect(log).not.toHaveBeenCalled();
  });
});

describe('control subject observation', () => {
  const CONTROL = 'synthetic-control-subject';

  beforeEach(() => {
    vi.stubEnv(KILO_TOKEN_ADMISSION_CONTROL_SUBJECT, CONTROL);
  });

  it('marks an accepted single-audience or audience-less control token on every verifier', async () => {
    await verifyKiloTokenForResource(
      await legacyToken({ kiloUserId: CONTROL, aud: 'kilo-api' }),
      SECRET,
      API_POLICY
    );
    await verifyKiloTokenForPolicy(await legacyToken({ kiloUserId: CONTROL }), SECRET, API_POLICY);
    await verifyKiloToken(
      await legacyToken({ kiloUserId: CONTROL, aud: 'session-ingest' }),
      SECRET,
      {
        audience: 'session-ingest',
      }
    );

    expect(lines()).toEqual([
      {
        event: 'kilo_token_admission',
        v: 1,
        boundary: 'resource',
        policy_audience: 'kilo-api',
        outcome: 'admitted',
        multi: false,
        control: true,
        aud_set: 'kilo-api',
        issuer: 'unknown',
      },
      expect.objectContaining({ boundary: 'policy', control: true, aud_set: 'none' }),
      expect.objectContaining({ boundary: 'exact_audience', control: true }),
    ]);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain(CONTROL);
  });

  it('never marks a multi-audience control token, which stays a multi line', async () => {
    await verifyKiloTokenForResource(
      await legacyToken({ kiloUserId: CONTROL, aud: BOTH_AUDIENCES }),
      SECRET,
      API_POLICY
    );

    expect(lines()).toEqual([expect.objectContaining({ multi: true, control: false })]);
  });

  it.each([
    ['another subject', { kiloUserId: 'synthetic-other-subject' }],
    [
      'an internal bot token of the control subject',
      { kiloUserId: CONTROL, tokenSource: 'internal-bot' },
    ],
  ])('writes nothing for %s', async (_label, claims) => {
    await verifyKiloTokenForResource(await legacyToken(claims), SECRET, API_POLICY);

    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['a forged signature', { secret: 'forged-secret-at-least-32-characters' }],
    ['an expired token', { expiresInSeconds: -60 }],
  ])('writes nothing when it refuses %s', async (_label, options) => {
    const token = await legacyToken({ kiloUserId: CONTROL }, options);

    await expect(verifyKiloTokenForResource(token, SECRET, API_POLICY)).rejects.toThrow();

    expect(log).not.toHaveBeenCalled();
  });

  it('writes nothing while the observation flag is off', async () => {
    vi.stubEnv(KILO_TOKEN_ADMISSION_OBSERVATION_FLAG, '');

    await verifyKiloTokenForResource(
      await legacyToken({ kiloUserId: CONTROL }),
      SECRET,
      API_POLICY
    );

    expect(log).not.toHaveBeenCalled();
  });

  it.each(['', ' synthetic-control-subject', 'a b', 'a,b', 'bot-internal-synthetic'])(
    'configures no control subject for %j',
    raw => {
      expect(parseAdmissionControlSubject(raw)).toBeNull();
    }
  );

  it('marks nothing under a refused control subject', async () => {
    vi.stubEnv(KILO_TOKEN_ADMISSION_CONTROL_SUBJECT, `${CONTROL},other`);

    await verifyKiloTokenForResource(
      await legacyToken({ kiloUserId: CONTROL }),
      SECRET,
      API_POLICY
    );

    expect(log).not.toHaveBeenCalled();
  });
});
