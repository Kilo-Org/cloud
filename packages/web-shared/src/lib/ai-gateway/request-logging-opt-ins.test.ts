import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ai_gateway_request_logging_opt_ins } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  createRequestLoggingOptIn,
  deleteExpiredRequestLoggingOptIns,
  deleteRequestLoggingOptIn,
  getRequestLoggingOptIns,
  resolveRequestLoggingMode,
  RequestLoggingOptInsSchema,
  type RequestLoggingOptIn,
} from './request-logging-opt-ins';

const optIns: RequestLoggingOptIn[] = [
  {
    id: '065f4f9c-1608-4bb8-8b31-ee84cf790b21',
    target_type: 'account',
    target_id: 'account-1',
    reason: 'Investigate a support report',
    added_by_email: 'admin@kilo.ai',
    added_at: '2026-07-14T12:00:00.000Z',
    errors_only: false,
  },
  {
    id: '3412d528-081a-492f-be96-c50f8c4e6b9f',
    target_type: 'organization',
    target_id: 'org-1',
    reason: 'Investigate elevated errors',
    added_by_email: 'admin@kilo.ai',
    added_at: '2026-07-14T12:01:00.000Z',
    errors_only: true,
  },
];

describe('request logging opt-ins', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('matches account and organization IDs by type', () => {
    expect(
      resolveRequestLoggingMode(optIns, { accountId: 'account-1', organizationId: null })
    ).toBe('all');
    expect(resolveRequestLoggingMode(optIns, { accountId: null, organizationId: 'org-1' })).toBe(
      'errors_only'
    );
    expect(
      resolveRequestLoggingMode(optIns, { accountId: 'org-1', organizationId: 'account-1' })
    ).toBeNull();
  });

  test('prefers logging all requests when an errors-only opt-in also matches', () => {
    expect(
      resolveRequestLoggingMode(optIns, { accountId: 'account-1', organizationId: 'org-1' })
    ).toBe('all');
    expect(
      resolveRequestLoggingMode(optIns, { accountId: 'account-2', organizationId: 'org-1' })
    ).toBe('errors_only');
  });

  test('validates persisted audit metadata', () => {
    expect(RequestLoggingOptInsSchema.parse(optIns)).toEqual(optIns);
    expect(() =>
      RequestLoggingOptInsSchema.parse([
        {
          ...optIns[0],
          reason: '',
          added_by_email: 'not-an-email',
        },
      ])
    ).toThrow();
  });

  test('treats persisted opt-ins without errors_only as logging all requests', () => {
    const { errors_only: _errorsOnly, ...legacyOptIn } = optIns[0];
    expect(RequestLoggingOptInsSchema.parse([legacyOptIn])).toEqual([
      { ...legacyOptIn, errors_only: false },
    ]);
  });

  test('accepts optional ISO expiry and rejects invalid expiry values', () => {
    expect(
      RequestLoggingOptInsSchema.parse([{ ...optIns[0], expires_at: '2026-12-01T00:00:00Z' }])
    ).toHaveLength(1);
    for (const expires_at of ['invalid', '2026-12-01', null]) {
      expect(() => RequestLoggingOptInsSchema.parse([{ ...optIns[0], expires_at }])).toThrow();
    }
  });

  test('stops matching an unchanged cached opt-in at its expiry boundary', () => {
    const expiresAt = Date.parse('2026-11-02T12:00:00Z');
    const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
    const cached = [{ ...optIns[0], expires_at: new Date(expiresAt).toISOString() }];
    const params = { accountId: 'account-1', organizationId: null };

    expect(resolveRequestLoggingMode(cached, params)).toBe('all');
    now.mockReturnValue(expiresAt);
    expect(resolveRequestLoggingMode(cached, params)).toBeNull();
    now.mockReturnValue(expiresAt + 1);
    expect(resolveRequestLoggingMode(cached, params)).toBeNull();
  });

  test('does not let an expired all-requests opt-in override an active errors-only opt-in', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T12:00:00Z'));
    expect(
      resolveRequestLoggingMode([{ ...optIns[0], expires_at: '2026-11-02T11:59:59Z' }, optIns[1]], {
        accountId: 'account-1',
        organizationId: 'org-1',
      })
    ).toBe('errors_only');
  });

  test('disables all logging when more than ten opt-ins are stored', () => {
    const params = { accountId: 'account-1', organizationId: null };
    const atLimit = [
      optIns[0],
      ...Array.from({ length: 9 }, (_, index) => ({
        ...optIns[1],
        id: `3412d528-081a-492f-be96-c50f8c4e6b${String(index).padStart(2, '0')}`,
      })),
    ];

    expect(resolveRequestLoggingMode(atLimit, params)).toBe('all');
    expect(
      resolveRequestLoggingMode(
        [...atLimit, { ...optIns[1], id: '99b6f9d5-1c2f-4b4e-8b3a-2f0a1c6d4e5f' }],
        params
      )
    ).toBeNull();
  });
});

describe('request logging opt-in persistence', () => {
  function makeOptIn(overrides: Partial<RequestLoggingOptIn> = {}): RequestLoggingOptIn {
    return {
      ...optIns[0],
      id: crypto.randomUUID(),
      target_id: `oauth/request-logging/${crypto.randomUUID()}`,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await db
      .delete(ai_gateway_request_logging_opt_ins)
      .where(eq(ai_gateway_request_logging_opt_ins.id, 1));
  });

  test('serializes concurrent creation at the tenth opt-in', async () => {
    const existing = Array.from({ length: 9 }, () => makeOptIn());
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: existing });

    const results = await Promise.all([
      createRequestLoggingOptIn(makeOptIn()),
      createRequestLoggingOptIn(makeOptIn({ target_type: 'organization' })),
    ]);

    expect(results.sort()).toEqual(['created', 'full']);
    expect(await getRequestLoggingOptIns()).toHaveLength(10);
  });

  test('enforces the limit even when concurrent writers initialize the singleton', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => createRequestLoggingOptIn(makeOptIn()))
    );

    expect(results.filter(result => result === 'created')).toHaveLength(10);
    expect(results.filter(result => result === 'full')).toHaveLength(2);
    expect(await getRequestLoggingOptIns()).toHaveLength(10);
  });

  test('replaces an expired duplicate without waiting for the cleanup cron', async () => {
    const expired = makeOptIn({ expires_at: '2020-01-01T00:00:00Z' });
    const existing = Array.from({ length: 9 }, () => makeOptIn());
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: [...existing, expired] });
    const replacement = makeOptIn({ target_id: expired.target_id });

    expect(await createRequestLoggingOptIn(replacement)).toBe('created');
    expect(await getRequestLoggingOptIns()).toEqual([...existing, replacement]);
  });

  test('preserves a concurrently created opt-in during expiration cleanup', async () => {
    const expired = makeOptIn({ expires_at: '2020-01-01T00:00:00Z' });
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: [expired] });
    const created = makeOptIn();

    const [, result] = await Promise.all([
      deleteExpiredRequestLoggingOptIns(),
      createRequestLoggingOptIn(created),
    ]);

    expect(result).toBe('created');
    expect(await getRequestLoggingOptIns()).toEqual([created]);
  });

  test('keeps legacy lists above ten readable and deletable but rejects additional rules', async () => {
    const existing = Array.from({ length: 11 }, () => makeOptIn());
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: existing });

    expect(await createRequestLoggingOptIn(makeOptIn())).toBe('full');
    expect(await deleteRequestLoggingOptIn(existing[0].id)).toEqual(existing[0]);
    expect(await getRequestLoggingOptIns()).toEqual(existing.slice(1));
  });
});
