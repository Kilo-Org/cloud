jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  pool: { totalCount: 4, idleCount: 1, waitingCount: 0, options: { max: 10 } },
}));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
  createPhaseTimer,
  describeDatabaseError,
  isUsageRowConflict,
  observeUsageRecordCompletion,
  readPoolGauges,
  shouldEmitUsageRecordTiming,
  stackFramesUnderHeader,
} from './usage-record-diagnostics';

describe('shared usage completion observations', () => {
  const usage = {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    created_at: '2026-04-29T01:16:12.945Z',
    user_prompt_prefix: 'sensitive-prompt',
    secret: 'sensitive-secret',
  };
  const recorded = {
    usageId: usage.id,
    createdAt: usage.created_at,
    newMicrodollarsUsed: 1234,
    wasRedelivery: false,
  };
  let info: jest.SpiedFunction<typeof console.info>;
  let warn: jest.SpiedFunction<typeof console.warn>;
  beforeEach(() => {
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'test',
      VERCEL_ENV: undefined,
      VERCEL_TARGET_ENV: undefined,
      VERCEL_REGION: 'fra1',
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([false, true])(
    'logs every nonproduction completion, including duplicate=%s',
    async wasRedelivery => {
      const result = { ...recorded, wasRedelivery };
      jest.spyOn(Math, 'random').mockReturnValue(1);
      expect(await observeUsageRecordCompletion(usage, async () => result)).toBe(result);
      expect(info).toHaveBeenCalledTimes(1);
      expect(JSON.parse(info.mock.calls[0][0])).toEqual({
        level: 'info',
        event: 'usage_record_completion',
        sample_rate: 1,
        usage_id: usage.id,
        outcome: wasRedelivery ? 'duplicate' : 'recorded',
        entrypoint: 'unknown',
        writer_caller: 'unknown',
        duration_ms: expect.any(Number),
        event_age_ms: expect.any(Number),
        execution_region: 'fra1',
      });
      expect(warn).not.toHaveBeenCalled();
      expect(JSON.stringify(info.mock.calls)).not.toContain('sensitive');
    }
  );

  test.each([
    { random: 0, emitted: true },
    { random: 0.009999, emitted: true },
    { random: 0.01, emitted: false },
  ])('samples production successes at the 1% boundary: %j', async ({ random, emitted }) => {
    process.env.VERCEL_ENV = 'production';
    jest.spyOn(Math, 'random').mockReturnValue(random);
    for (const wasRedelivery of [false, true]) {
      const result = { ...recorded, wasRedelivery };
      const write = jest.fn(async () => result);
      expect(await observeUsageRecordCompletion(usage, write)).toBe(result);
      expect(write).toHaveBeenCalledTimes(1);
    }
    expect(info).toHaveBeenCalledTimes(emitted ? 2 : 0);
    expect(warn).not.toHaveBeenCalled();
    if (emitted) {
      expect(info.mock.calls.map(([value]) => JSON.parse(value))).toEqual([
        expect.objectContaining({ outcome: 'recorded', sample_rate: 0.01 }),
        expect.objectContaining({ outcome: 'duplicate', sample_rate: 0.01 }),
      ]);
    }
  });

  test.each([
    { node: 'production', vercel: 'production', target: undefined, rate: 0.01 },
    { node: 'production', vercel: 'production', target: 'staging', rate: 0.01 },
    { node: 'test', vercel: 'production', target: 'staging', rate: 0.01 },
    { node: 'production', vercel: undefined, target: 'staging', rate: 1 },
    { node: 'production', vercel: 'preview', target: undefined, rate: 1 },
    { node: 'production', vercel: 'development', target: undefined, rate: 1 },
    { node: 'production', vercel: undefined, target: undefined, rate: 0.01 },
    { node: 'test', vercel: undefined, target: undefined, rate: 1 },
    { node: 'development', vercel: undefined, target: undefined, rate: 1 },
    { node: undefined, vercel: undefined, target: undefined, rate: 1 },
  ] as const)(
    'uses deployment context for success sampling: %j',
    async ({ node, vercel, target, rate }) => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        NODE_ENV: node ?? 'test',
        VERCEL_ENV: vercel,
        VERCEL_TARGET_ENV: target,
      });
      if (node === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.005);
      expect(await observeUsageRecordCompletion(usage, async () => recorded)).toBe(recorded);
      expect(info).toHaveBeenCalledTimes(1);
      expect(JSON.parse(info.mock.calls[0][0]).sample_rate).toBe(rate);
      expect(random).toHaveBeenCalledTimes(rate === 1 ? 0 : 1);
    }
  );

  test('retains finite caller context without changing the write result', async () => {
    expect(
      await observeUsageRecordCompletion(usage, async () => recorded, {
        entrypoint: 'writer_endpoint',
        writer_caller: 'queue',
      })
    ).toBe(recorded);
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({
      entrypoint: 'writer_endpoint',
      writer_caller: 'queue',
    });
  });

  test('waits for the full operation and measures monotonic elapsed time', async () => {
    let now = 100;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(usage.created_at) + 2000);
    const delayed = Promise.withResolvers<typeof recorded>();
    const work = observeUsageRecordCompletion(usage, () => delayed.promise);
    expect(info).not.toHaveBeenCalled();
    now = 375;
    delayed.resolve(recorded);
    expect(await work).toBe(recorded);
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({
      duration_ms: 275,
      event_age_ms: 2000,
    });
  });

  test('distinguishes null outcomes from thrown failures without exposing errors', async () => {
    process.env.VERCEL_ENV = 'production';
    const random = jest.spyOn(Math, 'random').mockReturnValue(1);
    expect(await observeUsageRecordCompletion(usage, async () => null)).toBeNull();
    const failure = new Error('sensitive exception with SQL and credentials');
    await expect(
      observeUsageRecordCompletion(usage, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(
      warn.mock.calls.map(([value]) => {
        const log = JSON.parse(value);
        return { outcome: log.outcome, sample_rate: log.sample_rate };
      })
    ).toEqual([
      { outcome: 'not_recorded', sample_rate: 1 },
      { outcome: 'error', sample_rate: 1 },
    ]);
    expect(random).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive');
  });

  test.each([0, 0.5])(
    'preserves results/errors with broken console and random=%s',
    async random => {
      process.env.VERCEL_ENV = 'production';
      jest.spyOn(Math, 'random').mockReturnValue(random);
      info.mockImplementation(() => {
        throw new Error('synthetic log failure');
      });
      warn.mockImplementation(() => {
        throw new Error('synthetic log failure');
      });
      expect(await observeUsageRecordCompletion(usage, async () => recorded)).toBe(recorded);
      const duplicate = { ...recorded, wasRedelivery: true };
      expect(await observeUsageRecordCompletion(usage, async () => duplicate)).toBe(duplicate);
      expect(info).toHaveBeenCalledTimes(random === 0 ? 2 : 0);
      expect(await observeUsageRecordCompletion(usage, async () => null)).toBeNull();
      const failure = new Error('original write failure');
      await expect(
        observeUsageRecordCompletion(usage, async () => {
          throw failure;
        })
      ).rejects.toBe(failure);
    }
  );

  test('handles database-shaped timestamps, clock skew and unknown timestamps/regions safely', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(usage.created_at) + 2000);
    await observeUsageRecordCompletion(
      { ...usage, created_at: '2026-04-29 01:16:12.945+00' },
      async () => recorded
    );
    expect(JSON.parse(info.mock.calls[0][0]).event_age_ms).toBe(2000);
    jest.spyOn(Date, 'now').mockReturnValue(0);
    await observeUsageRecordCompletion(usage, async () => recorded);
    expect(JSON.parse(info.mock.calls[1][0]).event_age_ms).toBe(0);
    process.env.VERCEL_REGION = 'sensitive-unexpected-value';
    await observeUsageRecordCompletion(
      { ...usage, created_at: 'sensitive-invalid-timestamp' },
      async () => recorded
    );
    const log = JSON.parse(info.mock.calls[2][0]);
    expect(log).not.toHaveProperty('event_age_ms');
    expect(log.execution_region).toBe('unknown');
    expect(JSON.stringify(info.mock.calls)).not.toContain('sensitive');
  });
});

/** Shape of the drizzle wrapper: a message carrying the statement, plus a cause. */
function drizzleError(cause: Record<string, unknown>) {
  const error = new Error(
    'Failed query: WITH microdollar_usage_ins AS (...) params: 3f5826e7,You are Kilo,134.82.68.167'
  );
  error.name = 'DrizzleQueryError';
  (error as unknown as { cause: unknown }).cause = Object.assign(new Error('driver'), cause);
  return error;
}

describe('describeDatabaseError', () => {
  test('extracts driver fields from the wrapped cause', () => {
    const described = describeDatabaseError(
      drizzleError({
        code: '23505',
        constraint: 'PK_a71b90d910e7882358c3defe8e2',
        table: 'microdollar_usage',
        routine: '_bt_check_unique',
      })
    );
    expect(described).toEqual({
      name: 'DrizzleQueryError',
      code: '23505',
      constraint: 'PK_a71b90d910e7882358c3defe8e2',
      table: 'microdollar_usage',
      routine: '_bt_check_unique',
    });
  });

  // The whole point of this helper: nothing it returns may carry the statement or
  // its interpolated parameters, which include prompt text and the client IP.
  test('returns no field containing the statement or its parameters', () => {
    const described = describeDatabaseError(
      drizzleError({ code: '23505', table: 'microdollar_usage' })
    );
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain('You are Kilo');
    expect(serialized).not.toContain('134.82.68.167');
    expect(serialized).not.toContain('microdollar_usage_ins');
    expect(serialized).not.toContain('params:');
  });

  test('omits detail, which PostgreSQL fills with the conflicting values', () => {
    const described = describeDatabaseError(
      drizzleError({
        code: '23505',
        table: 'microdollar_usage',
        detail: 'Key (id)=(3f5826e7-b563-4850-b34d-d9e4cd3978fc) already exists.',
      })
    );
    expect(JSON.stringify(described)).not.toContain('already exists');
  });

  test('walks a nested cause chain', () => {
    const inner = Object.assign(new Error('driver'), { code: '40P01' });
    const middle = Object.assign(new Error('mid'), { cause: inner });
    const outer = Object.assign(new Error('outer'), { cause: middle });
    expect(describeDatabaseError(outer).code).toBe('40P01');
  });

  test('degrades to nulls for a non-database error', () => {
    expect(describeDatabaseError(new Error('boom'))).toEqual({
      name: 'Error',
      code: null,
      constraint: null,
      table: null,
      routine: null,
    });
  });

  test('does not throw on null or a primitive', () => {
    expect(describeDatabaseError(null).code).toBeNull();
    expect(describeDatabaseError('nope').code).toBeNull();
  });
});

describe('stackFramesUnderHeader', () => {
  // The regression this exists to prevent: `error.stack` opens with
  // `name: message`, so copying it verbatim onto a redacted error puts the
  // interpolated statement straight back into the Sentry event.
  test('drops the original header, which contains the statement', () => {
    const stack = stackFramesUnderHeader(
      drizzleError({ code: '23505', table: 'microdollar_usage' }),
      'Error: insertUsageRecord failed (code=23505)'
    );
    expect(stack).not.toContain('You are Kilo');
    expect(stack).not.toContain('134.82.68.167');
    expect(stack).not.toContain('microdollar_usage_ins');
    expect(stack).not.toContain('params:');
    expect(stack).not.toContain('Failed query');
  });

  test('keeps the frames, so the throw site survives redaction', () => {
    const error = new Error('secret message');
    error.stack = 'Error: secret message\n    at inner (chunk.js:1:1)\n    at outer (chunk.js:2:2)';
    expect(stackFramesUnderHeader(error, 'Error: redacted')).toBe(
      'Error: redacted\n    at inner (chunk.js:1:1)\n    at outer (chunk.js:2:2)'
    );
  });

  test('removes a multi-line message in full', () => {
    const error = new Error('line one\nline two\nparams: secret');
    error.stack = 'Error: line one\nline two\nparams: secret\n    at inner (chunk.js:1:1)';
    expect(stackFramesUnderHeader(error, 'Error: redacted')).toBe(
      'Error: redacted\n    at inner (chunk.js:1:1)'
    );
  });

  // A user pasting a stack trace into their prompt is routine for a coding
  // assistant, and `user_prompt_prefix` is interpolated into the message. Anchoring
  // on the first frame-shaped line would start the slice inside the message and
  // carry the remaining parameters — client IP, city — into the result.
  test('does not leak parameters when the prompt itself contains a stack trace', () => {
    const prompt = 'Fix this:\n    at handler (app.js:10:5)\n    at run (app.js:2:1)';
    const error = new Error(
      `Failed query: WITH microdollar_usage_ins AS (...)\nparams: 3f5826e7,${prompt},134.82.68.167,Miami`
    );
    error.name = 'DrizzleQueryError';

    const stack = stackFramesUnderHeader(error, 'Error: redacted');

    expect(stack).not.toContain('134.82.68.167');
    expect(stack).not.toContain('Miami');
    expect(stack).not.toContain('Fix this');
    expect(stack).not.toContain('app.js');
    expect(stack).not.toContain('params:');
  });

  // Fails closed: an unrecognised header means the message boundary is unknown.
  test('emits no frames when the stack does not start with the expected header', () => {
    const error = new Error('secret params: 134.82.68.167');
    error.stack = 'SomethingElse: unrelated\n    at inner (chunk.js:1:1)';
    expect(stackFramesUnderHeader(error, 'Error: redacted')).toBe('Error: redacted');
  });

  test('handles an empty message, whose header is the name alone', () => {
    const error = new Error('');
    error.stack = 'Error\n    at inner (chunk.js:1:1)';
    expect(stackFramesUnderHeader(error, 'Error: redacted')).toBe(
      'Error: redacted\n    at inner (chunk.js:1:1)'
    );
  });

  test('drops non-frame lines that survive the strip', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\ntrailing junk\n    at inner (chunk.js:1:1)';
    expect(stackFramesUnderHeader(error, 'Error: redacted')).toBe(
      'Error: redacted\n    at inner (chunk.js:1:1)'
    );
  });

  test('falls back to the header alone when there are no frames', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom';
    expect(stackFramesUnderHeader(error, 'Error: redacted')).toBe('Error: redacted');
  });

  test('returns the header for a non-error', () => {
    expect(stackFramesUnderHeader('nope', 'Error: redacted')).toBe('Error: redacted');
    expect(stackFramesUnderHeader(null, 'Error: redacted')).toBe('Error: redacted');
  });
});

describe('isUsageRowConflict', () => {
  test('is true for the usage row primary key', () => {
    expect(isUsageRowConflict(drizzleError({ code: '23505', table: 'microdollar_usage' }))).toBe(
      true
    );
  });

  test('is true for the usage metadata primary key, also keyed by the delivery id', () => {
    expect(
      isUsageRowConflict(drizzleError({ code: '23505', table: 'microdollar_usage_metadata' }))
    ).toBe(true);
  });

  // These MUST stay retryable: two concurrent writes can both pass the
  // `WHERE NOT EXISTS` guard for a new value, and the retry then skips the insert.
  test.each([
    'http_ip',
    'http_user_agent',
    'system_prompt_prefix',
    'ja4_digest',
    'vercel_ip_city',
    'finish_reason',
  ])('is false for the deduplicated lookup table %s', table => {
    expect(isUsageRowConflict(drizzleError({ code: '23505', table }))).toBe(false);
  });

  test('falls back to the constraint name when the driver omits table', () => {
    expect(
      isUsageRowConflict(
        drizzleError({ code: '23505', constraint: 'PK_a71b90d910e7882358c3defe8e2' })
      )
    ).toBe(true);
    expect(isUsageRowConflict(drizzleError({ code: '23505', constraint: 'http_ip_pkey' }))).toBe(
      false
    );
  });

  test.each([
    ['serialization failure', '40001'],
    ['deadlock', '40P01'],
    ['statement timeout', '57014'],
    ['connection failure', '08006'],
  ])('is false for %s, which a retry can resolve', (_label, code) => {
    expect(isUsageRowConflict(drizzleError({ code, table: 'microdollar_usage' }))).toBe(false);
  });

  test('is false for an error with no driver code', () => {
    expect(isUsageRowConflict(new Error('boom'))).toBe(false);
  });
});

describe('createPhaseTimer', () => {
  test('records each phase duration and the running total', () => {
    let now = 1_000;
    const timer = createPhaseTimer(() => now);
    now = 1_010;
    timer.mark('validate');
    now = 1_035;
    timer.mark('dedupe_check');
    now = 6_035;
    timer.mark('write');
    expect(timer.phases()).toEqual([
      { phase: 'validate', ms: 10 },
      { phase: 'dedupe_check', ms: 25 },
      { phase: 'write', ms: 5_000 },
    ]);
    expect(timer.totalMs()).toBe(5_035);
  });
});

describe('readPoolGauges', () => {
  test('reports the in-process pool counters, not Supavisor stats', () => {
    expect(readPoolGauges()).toEqual({ total: 4, idle: 1, waiting: 0 });
  });
});

describe('shouldEmitUsageRecordTiming', () => {
  test('always emits at or above the slow threshold', () => {
    expect(shouldEmitUsageRecordTiming(1_000, () => 1)).toBe(true);
    expect(shouldEmitUsageRecordTiming(50_000, () => 1)).toBe(true);
  });

  test('samples a small fraction of fast requests for a baseline', () => {
    expect(shouldEmitUsageRecordTiming(5, () => 0.005)).toBe(true);
    expect(shouldEmitUsageRecordTiming(5, () => 0.5)).toBe(false);
  });
});
