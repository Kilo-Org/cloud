import { beforeEach, describe, expect, it } from '@jest/globals';
import { captureMessage } from '@sentry/nextjs';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  releaseSpendHold,
  reservePaidSpend,
  spendPayerKey,
} from '@kilocode/web-shared/lib/ai-gateway/spend-reservation';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { eval: jest.fn() },
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

const evalMock = jest.mocked(redisClient.eval);

/** The store scripts, as the caller addresses them: counter first, then this request's hold. */
function storeReply(value: unknown) {
  evalMock.mockResolvedValueOnce(value as never);
}

describe('spendPayerKey', () => {
  it('counts an organization request against the organization and a personal one against the user', () => {
    expect(spendPayerKey({ organizationId: 'org-1', userId: 'user-1' })).toBe('organization:org-1');
    expect(spendPayerKey({ organizationId: undefined, userId: 'user-1' })).toBe('user:user-1');
  });
});

describe('reservePaidSpend', () => {
  beforeEach(() => {
    evalMock.mockReset();
    jest.mocked(captureMessage).mockClear();
  });

  it('holds the request amount against the payer balance for the usage id', async () => {
    storeReply(1);

    const reservation = await reservePaidSpend({
      usageId: 'usage-1',
      payer: { organizationId: undefined, userId: 'user-1' },
      amountMicrodollars: 1_500,
      availableMicrodollars: 4_000,
    });

    expect(reservation).toMatchObject({ kind: 'reserved', amountMicrodollars: 1_500 });
    const [script, keys, args] = evalMock.mock.calls[0]!;
    expect(script).toContain('INCRBY');
    expect(keys).toEqual(['gateway-spend-reserved:user:user-1', 'gateway-spend-hold:usage-1']);
    expect(args).toEqual(['1500', '4000', '900000', 'user:user-1|1500']);
  });

  it('refuses the request when the holds already taken leave too little of the balance', async () => {
    storeReply(0);

    await expect(
      reservePaidSpend({
        usageId: 'usage-2',
        payer: { organizationId: 'org-1', userId: 'user-1' },
        amountMicrodollars: 3_000,
        availableMicrodollars: 4_000,
      })
    ).resolves.toEqual({ kind: 'insufficient' });
    expect(evalMock.mock.calls[0]![1]).toEqual([
      'gateway-spend-reserved:organization:org-1',
      'gateway-spend-hold:usage-2',
    ]);
  });

  it('holds nothing when the store does not answer, and reports once', async () => {
    evalMock.mockRejectedValue(new Error('redis down'));

    await expect(
      reservePaidSpend({
        usageId: 'usage-3',
        payer: { organizationId: undefined, userId: 'user-1' },
        amountMicrodollars: 1_500,
        availableMicrodollars: 4_000,
      })
    ).resolves.toEqual({ kind: 'unavailable' });
    await reservePaidSpend({
      usageId: 'usage-4',
      payer: { organizationId: undefined, userId: 'user-1' },
      amountMicrodollars: 1_500,
      availableMicrodollars: 4_000,
    });

    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('reserves nothing for a zero amount', async () => {
    const reservation = await reservePaidSpend({
      usageId: 'usage-5',
      payer: { organizationId: undefined, userId: 'user-1' },
      amountMicrodollars: 0,
      availableMicrodollars: 4_000,
    });

    expect(reservation).toMatchObject({ kind: 'reserved', amountMicrodollars: 0 });
    if (reservation.kind !== 'reserved') throw new Error('expected a reservation');
    await reservation.release();
    expect(evalMock).not.toHaveBeenCalled();
  });
});

describe('releaseSpendHold', () => {
  beforeEach(() => {
    evalMock.mockReset();
    jest.mocked(captureMessage).mockClear();
  });

  it('consumes this usage id hold from its payer counter', async () => {
    storeReply(1);

    await releaseSpendHold('usage-1');

    const [script, keys, args] = evalMock.mock.calls[0]!;
    expect(script).toContain('DECRBY');
    expect(keys).toEqual(['gateway-spend-hold:usage-1']);
    expect(args).toEqual(['gateway-spend-reserved:']);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('reports a failed release and leaves the hold to its expiry', async () => {
    evalMock.mockRejectedValue(new Error('redis down'));

    await expect(releaseSpendHold('usage-1')).resolves.toBeUndefined();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});
