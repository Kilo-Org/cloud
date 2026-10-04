import { describe, expect, it } from '@jest/globals';
import { DrizzleQueryError } from 'drizzle-orm';

import { sanitizeErrorForTelemetry } from './sanitize-error-for-telemetry';

const PURCHASE_TOKEN = 'play-purchase-token-abc123';

function drizzleFailure(cause?: Error): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "credit_transactions" ("id", "stripe_payment_id") values ($1, $2)',
    ['tx-1', `store-credit:google_play:${PURCHASE_TOKEN}`],
    cause
  );
}

function causeOf(error: Error): Error | undefined {
  return error.cause instanceof Error ? error.cause : undefined;
}

function codeOf(error: Error): unknown {
  return 'code' in error ? error.code : undefined;
}

describe('sanitizeErrorForTelemetry', () => {
  it('replaces the bound parameters of a failed query and keeps the diagnostics', () => {
    const cause = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    const captured = sanitizeErrorForTelemetry(drizzleFailure(cause));
    const capturedCause = causeOf(captured);

    expect(captured).not.toBeInstanceOf(DrizzleQueryError);
    expect(captured.message).toContain('insert into "credit_transactions"');
    expect(captured.message).not.toContain(PURCHASE_TOKEN);
    expect(captured.message).toContain('params: [redacted]');
    expect(capturedCause?.message).toBe('deadlock detected');
    expect(capturedCause && codeOf(capturedCause)).toBe('40P01');
  });

  // Sentry's `beforeSend` only rewrites the exception when it can still
  // recognize a Drizzle wrapper, so the shape has to survive sanitizing.
  it('keeps the query and parameter shape Sentry groups on', () => {
    const captured = sanitizeErrorForTelemetry(drizzleFailure());

    expect(captured).toMatchObject({
      query: expect.stringContaining('credit_transactions'),
      params: ['[redacted]', '[redacted]'],
    });
    expect(JSON.stringify(captured)).not.toContain(PURCHASE_TOKEN);
  });

  // A stack repeats the message ahead of its frames, and a Drizzle message
  // spans two lines (the query, then `params: …`), so the parameter line has to
  // go with the header even when no secret is known.
  it('drops the bound parameters from the stack when no secret is known', () => {
    const captured = sanitizeErrorForTelemetry(drizzleFailure());
    const stack = captured.stack ?? '';

    expect(stack.split('\n')[0]).toContain('Failed query:');
    expect(stack.split('\n')[1]).toBe('params: [redacted]');
    expect(stack).not.toContain(PURCHASE_TOKEN);
    // The frame lines are the part of the original stack that is kept.
    expect(stack).toMatch(/\n\s*at /);
  });

  it('redacts a known secret from the message, the stack, and nested causes', () => {
    const failure = Object.assign(new Error(`Request failed for /tokens/${PURCHASE_TOKEN}`), {
      cause: new Error(`provider rejected ${PURCHASE_TOKEN}`),
    });

    const captured = sanitizeErrorForTelemetry(failure, [PURCHASE_TOKEN]);

    expect(captured.message).not.toContain(PURCHASE_TOKEN);
    expect(captured.stack ?? '').not.toContain(PURCHASE_TOKEN);
    expect(causeOf(captured)?.message).not.toContain(PURCHASE_TOKEN);
    expect(captured.message).toContain('[redacted]');
  });

  // A store SDK error carries the request it failed on, including the URL that
  // names the purchase token; only the listed fields may survive.
  it('drops properties nobody listed', () => {
    const failure = Object.assign(new Error('Request failed with status code 400'), {
      config: { url: `https://androidpublisher.googleapis.com/tokens/${PURCHASE_TOKEN}` },
      response: { status: 400 },
      code: 'ERR_BAD_REQUEST',
    });

    const captured = sanitizeErrorForTelemetry(failure, [PURCHASE_TOKEN]);

    expect(captured).not.toHaveProperty('config');
    expect(captured).not.toHaveProperty('response');
    expect(codeOf(captured)).toBe('ERR_BAD_REQUEST');
  });

  it('sanitizes a failed query that is a nested cause', () => {
    const failure = new Error('transaction rolled back', { cause: drizzleFailure() });

    const captured = sanitizeErrorForTelemetry(failure);
    const nested = causeOf(captured);

    expect(nested?.message).toContain('params: [redacted]');
    expect(nested?.message).not.toContain(PURCHASE_TOKEN);
    expect(nested?.stack ?? '').not.toContain(PURCHASE_TOKEN);
  });

  it('sanitizes the whole cause chain without unbounded recursion', () => {
    let chain: Error = new Error('root cause');
    for (let depth = 0; depth < 10; depth++) {
      chain = new Error(`layer ${depth}`, { cause: chain });
    }

    let depth = 0;
    let current: unknown = sanitizeErrorForTelemetry(chain).cause;
    while (current instanceof Error) {
      depth++;
      current = current.cause;
    }
    expect(depth).toBeLessThanOrEqual(5);
  });

  it('sanitizes a thrown value that is not an error', () => {
    expect(sanitizeErrorForTelemetry(`failed on ${PURCHASE_TOKEN}`, [PURCHASE_TOKEN]).message).toBe(
      'failed on [redacted]'
    );
    expect(sanitizeErrorForTelemetry(undefined).message).toBe('Unknown error');
  });
});
