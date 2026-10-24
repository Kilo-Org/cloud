import { describe, expect, test } from '@jest/globals';
import {
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
});
