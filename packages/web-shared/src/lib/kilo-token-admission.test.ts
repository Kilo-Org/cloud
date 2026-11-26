import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { DEFAULT_BENCHMARK_USER_ID } from '@kilocode/auto-routing-contracts';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import {
  KILO_TOKEN_ADMISSION_CONTROL_SUBJECT,
  KILO_TOKEN_ADMISSION_OBSERVATION_FLAG,
} from '@kilocode/worker-utils/kilo-token-admission-observation';
import { KILO_TOKEN_VERSION } from '@kilocode/worker-utils/kilo-token';
import {
  KILO_TOKEN_ADMISSION_COHORTS_VARIABLE,
  admissionClientFromHeaders,
  internalBotCohort,
  parseAdmissionCohorts,
} from '@kilocode/web-shared/lib/kilo-token-admission';
import { validateAuthorizationHeader } from '@kilocode/web-shared/lib/tokens';

const BOUNCER_WATCH = 'synthetic-watch-bot';
const WORK_SESSIONS = 'synthetic-work-sessions-bot';
const COHORTS = `bouncer_watch=${BOUNCER_WATCH}, kwf_work_sessions=${WORK_SESSIONS},kwf_other=synthetic-control-bot`;
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';

function signed(
  claims: Record<string, unknown>,
  options: { secret?: string; expiresIn?: number } = {}
) {
  return jwt.sign(
    {
      env: process.env.NODE_ENV,
      kiloUserId: BOUNCER_WATCH,
      apiTokenPepper: 'pepper',
      version: KILO_TOKEN_VERSION,
      ...claims,
    },
    options.secret ?? getEnvVariable('NEXTAUTH_SECRET'),
    { algorithm: 'HS256', expiresIn: options.expiresIn ?? 3600 }
  );
}

const botClaims = {
  tokenSource: 'internal-bot',
  organizationId: ORGANIZATION_ID,
  organizationRole: 'member',
};

function headers(token: string, extra: Record<string, string> = {}) {
  return new Headers({ authorization: `Bearer ${token}`, ...extra });
}

const originalEnv = {
  flag: process.env[KILO_TOKEN_ADMISSION_OBSERVATION_FLAG],
  cohorts: process.env[KILO_TOKEN_ADMISSION_COHORTS_VARIABLE],
  control: process.env[KILO_TOKEN_ADMISSION_CONTROL_SUBJECT],
};
let log: jest.SpiedFunction<typeof console.log>;

function lines() {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env[KILO_TOKEN_ADMISSION_OBSERVATION_FLAG] = 'true';
  process.env[KILO_TOKEN_ADMISSION_COHORTS_VARIABLE] = COHORTS;
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  restore(KILO_TOKEN_ADMISSION_OBSERVATION_FLAG, originalEnv.flag);
  restore(KILO_TOKEN_ADMISSION_COHORTS_VARIABLE, originalEnv.cohorts);
  restore(KILO_TOKEN_ADMISSION_CONTROL_SUBJECT, originalEnv.control);
  log.mockRestore();
});

describe('validateAuthorizationHeader admission observation', () => {
  it('reports an admitted kilo-api call of a bot cohort without raw identifiers', () => {
    const token = signed(botClaims);
    const result = validateAuthorizationHeader(
      headers(token, {
        'x-kilocode-editorname': 'Kilo CLI 7.1.0',
        'x-forwarded-for': '203.0.113.9',
      }),
      { observeAdmission: true }
    );

    expect(result.error).toBeUndefined();
    expect(lines()).toEqual([
      {
        event: 'kilo_token_admission',
        v: 1,
        boundary: 'web_bearer',
        policy_audience: 'kilo-api',
        outcome: 'admitted',
        multi: false,
        control: false,
        aud_set: 'none',
        issuer: 'internal_bot',
        cohort: 'bouncer_watch',
        client: 'cli_marked',
      },
    ]);
    const written = log.mock.calls.map(([line]) => String(line)).join('\n');
    for (const forbidden of [token, BOUNCER_WATCH, ORGANIZATION_ID, '203.0.113.9', '7.1.0']) {
      expect(written).not.toContain(forbidden);
    }
  });

  it('reports a signed gateway-only bot token that kilo-api refuses', () => {
    const result = validateAuthorizationHeader(
      headers(
        signed({ ...botClaims, kiloUserId: DEFAULT_BENCHMARK_USER_ID, aud: 'kilo-gateway' }),
        {
          'user-agent': 'Bun/1.3.0',
        }
      ),
      { observeAdmission: true }
    );

    expect(result.reason).toBe('audience_not_allowed');
    expect(lines()).toEqual([
      expect.objectContaining({
        policy_audience: 'kilo-api',
        outcome: 'audience_not_allowed',
        aud_set: 'kilo-gateway',
        cohort: 'benchmark',
        client: 'unmarked',
      }),
    ]);
  });

  it('reports an outdated-version bot token with its refusal reason', () => {
    validateAuthorizationHeader(headers(signed({ ...botClaims, version: 2 })), {
      observeAdmission: true,
    });

    expect(lines()).toEqual([
      expect.objectContaining({
        outcome: 'token_version_outdated',
        cohort: 'bouncer_watch',
        client: 'unknown',
      }),
    ]);
  });

  it('reports an accepted multi-audience token of any holder', () => {
    validateAuthorizationHeader(
      headers(signed({ kiloUserId: 'human-user', aud: ['kilo-api', 'kilo-gateway'] })),
      { observeAdmission: true }
    );

    expect(lines()).toEqual([
      expect.objectContaining({
        outcome: 'admitted',
        aud_set: 'kilo-api+kilo-gateway',
        issuer: 'unknown',
        cohort: 'not_internal_bot',
      }),
    ]);
  });

  it('marks a refused repeated-name array as multi although aud_set shows one name', () => {
    const result = validateAuthorizationHeader(
      headers(signed({ kiloUserId: 'human-user', aud: ['kilo-api', 'kilo-api'] })),
      { observeAdmission: true }
    );

    expect(result.reason).toBe('audience_not_allowed');
    expect(lines()).toEqual([
      expect.objectContaining({
        outcome: 'audience_not_allowed',
        multi: true,
        aud_set: 'kilo-api',
      }),
    ]);
  });

  it.each([
    ['a second read of the header', signed(botClaims), undefined, false],
    ['a bot gateway call', signed(botClaims), 'kilo-gateway', true],
    ['a human kilo-api call', signed({ kiloUserId: 'human-user' }), undefined, true],
    [
      'an MCP catalog token of the benchmark user',
      signed({ kiloUserId: DEFAULT_BENCHMARK_USER_ID, tokenSource: 'mcp-catalog' }),
      undefined,
      true,
    ],
  ])('writes nothing for %s', (_label, token, expectedAudience, observeAdmission) => {
    const result = validateAuthorizationHeader(headers(token), {
      expectedAudience,
      observeAdmission,
    });

    expect(result.error).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a forged signature',
      signed({ ...botClaims, aud: 'kilo-gateway' }, { secret: 'forged-secret-for-admission-test' }),
    ],
    ['an expired token', signed({ ...botClaims, aud: 'kilo-gateway' }, { expiresIn: -60 })],
  ])('writes nothing for %s', (_label, token) => {
    const result = validateAuthorizationHeader(headers(token), { observeAdmission: true });

    expect(result.reason).toBe('invalid_token');
    expect(log).not.toHaveBeenCalled();
  });

  it('writes nothing while the flag is off', () => {
    delete process.env[KILO_TOKEN_ADMISSION_OBSERVATION_FLAG];

    validateAuthorizationHeader(
      headers(signed({ ...botClaims, aud: ['kilo-api', 'kilo-gateway'] })),
      { observeAdmission: true }
    );

    expect(log).not.toHaveBeenCalled();
  });

  it('labels a bot unlisted under a refused cohort list without changing the verdict', () => {
    const token = signed({ ...botClaims, aud: 'kilo-gateway' });
    delete process.env[KILO_TOKEN_ADMISSION_OBSERVATION_FLAG];
    const unobserved = validateAuthorizationHeader(headers(token), { observeAdmission: true });
    process.env[KILO_TOKEN_ADMISSION_OBSERVATION_FLAG] = 'true';
    process.env[KILO_TOKEN_ADMISSION_COHORTS_VARIABLE] =
      `bouncer_watch=${BOUNCER_WATCH},kwf_other=${BOUNCER_WATCH}`;

    const observed = validateAuthorizationHeader(headers(token), { observeAdmission: true });

    expect(observed.reason).toBe('audience_not_allowed');
    expect({ ...observed, error: undefined }).toEqual({ ...unobserved, error: undefined });
    expect(lines()).toEqual([
      expect.objectContaining({
        outcome: 'audience_not_allowed',
        cohort: 'internal_bot_unlisted',
      }),
    ]);
  });
});

describe('web bearer control subject', () => {
  const CONTROL = 'synthetic-control-subject';

  beforeEach(() => {
    process.env[KILO_TOKEN_ADMISSION_CONTROL_SUBJECT] = CONTROL;
  });

  it('marks an admitted control token without writing its subject', () => {
    const result = validateAuthorizationHeader(headers(signed({ kiloUserId: CONTROL })), {
      observeAdmission: true,
    });

    expect(result.error).toBeUndefined();
    expect(lines()).toEqual([
      expect.objectContaining({
        outcome: 'admitted',
        multi: false,
        control: true,
        cohort: 'not_internal_bot',
      }),
    ]);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain(CONTROL);
  });

  it('writes nothing for a refused control token', () => {
    const result = validateAuthorizationHeader(
      headers(signed({ kiloUserId: CONTROL, aud: 'kilo-gateway' })),
      { observeAdmission: true }
    );

    expect(result.reason).toBe('audience_not_allowed');
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps a multi-audience control token a multi line', () => {
    validateAuthorizationHeader(
      headers(signed({ kiloUserId: CONTROL, aud: ['kilo-api', 'kilo-gateway'] })),
      { observeAdmission: true }
    );

    expect(lines()).toEqual([expect.objectContaining({ multi: true, control: false })]);
  });

  it('keeps an internal bot token of the control subject in its cohort, not control', () => {
    process.env[KILO_TOKEN_ADMISSION_CONTROL_SUBJECT] = BOUNCER_WATCH;

    validateAuthorizationHeader(headers(signed(botClaims)), { observeAdmission: true });

    expect(lines()).toEqual([expect.objectContaining({ cohort: 'bouncer_watch', control: false })]);
  });
});

describe('internalBotCohort', () => {
  const cohorts = parseAdmissionCohorts(COHORTS);

  it.each([
    [{ kiloUserId: BOUNCER_WATCH, tokenSource: 'internal-bot' }, 'bouncer_watch'],
    [{ kiloUserId: DEFAULT_BENCHMARK_USER_ID, tokenSource: 'internal-bot' }, 'benchmark'],
    [{ kiloUserId: WORK_SESSIONS, tokenSource: 'internal-bot' }, 'kwf_work_sessions'],
    [{ kiloUserId: 'synthetic-control-bot', tokenSource: 'internal-bot' }, 'kwf_other'],
    [
      { kiloUserId: 'synthetic-unlisted-bot', tokenSource: 'internal-bot' },
      'internal_bot_unlisted',
    ],
    [{ kiloUserId: 42, tokenSource: 'internal-bot' }, 'internal_bot_unlisted'],
    [{ kiloUserId: BOUNCER_WATCH }, 'not_internal_bot'],
    [{ kiloUserId: DEFAULT_BENCHMARK_USER_ID, tokenSource: 'mcp-catalog' }, 'not_internal_bot'],
  ])('classifies %j as %s', (claims, cohort) => {
    expect(internalBotCohort(claims, cohorts)).toBe(cohort);
  });
});

describe('parseAdmissionCohorts', () => {
  it('maps each configured subject to its label', () => {
    expect([...parseAdmissionCohorts(COHORTS)]).toEqual([
      [BOUNCER_WATCH, 'bouncer_watch'],
      [WORK_SESSIONS, 'kwf_work_sessions'],
      ['synthetic-control-bot', 'kwf_other'],
    ]);
  });

  it.each([
    ['unset', ''],
    ['a repeated subject', `bouncer_watch=${BOUNCER_WATCH},kwf_other=${BOUNCER_WATCH}`],
    ['an unknown label', `benchmark=${BOUNCER_WATCH}`],
    ['the default benchmark user', `kwf_other=${DEFAULT_BENCHMARK_USER_ID}`],
    ['a missing subject', 'bouncer_watch='],
    ['a missing separator', `bouncer_watch${BOUNCER_WATCH}`],
    ['an extra separator', `bouncer_watch=${BOUNCER_WATCH}=x`],
    ['an empty entry', `bouncer_watch=${BOUNCER_WATCH},`],
  ])('configures no cohort for %s', (_label, raw) => {
    const cohorts = parseAdmissionCohorts(raw);

    expect(cohorts.size).toBe(0);
    expect(
      internalBotCohort({ kiloUserId: BOUNCER_WATCH, tokenSource: 'internal-bot' }, cohorts)
    ).toBe('internal_bot_unlisted');
  });
});

describe('admissionClientFromHeaders', () => {
  it.each([
    [{ 'x-kilocode-editorname': 'Kilo CLI 7.1.0' }, 'cli_marked'],
    [{ 'user-agent': 'opencode-kilo-provider/7.1.0' }, 'cli_marked'],
    [{ 'user-agent': 'Kilo-Code/7.1.0' }, 'cli_marked'],
    [{ 'user-agent': 'Bun/1.3.0' }, 'unmarked'],
    [{ 'x-kilocode-editorname': 'Visual Studio Code 1.114.0' }, 'unmarked'],
    [{}, 'unknown'],
  ])('labels %j as %s', (values, client) => {
    expect(admissionClientFromHeaders(new Headers(values))).toBe(client);
  });
});
