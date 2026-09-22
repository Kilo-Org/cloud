import { describe, expect, test } from '@jest/globals';
import {
  EnabledOrganizationAlertRecipientsSchema,
  MAX_ORGANIZATION_ALERT_RECIPIENTS,
  OrganizationAlertRecipientsSchema,
} from './alert-recipients';

function addresses(count: number) {
  return Array.from({ length: count }, (_value, index) => `finance${index}@example.com`);
}

describe('OrganizationAlertRecipientsSchema', () => {
  test('trims, lowercases, and deduplicates by normalized identity', () => {
    expect(
      OrganizationAlertRecipientsSchema.parse([
        '  Finance@Example.com ',
        'finance@example.com',
        'FINANCE@EXAMPLE.COM',
        'ops+alerts@example.com',
      ])
    ).toEqual(['finance@example.com', 'ops+alerts@example.com']);
  });

  test('rejects an invalid address', () => {
    expect(OrganizationAlertRecipientsSchema.safeParse(['finance@']).success).toBe(false);
    expect(OrganizationAlertRecipientsSchema.safeParse(['finance example.com']).success).toBe(
      false
    );
    expect(OrganizationAlertRecipientsSchema.safeParse(['']).success).toBe(false);
  });

  test('rejects more distinct recipients than the cap', () => {
    expect(
      OrganizationAlertRecipientsSchema.safeParse(addresses(MAX_ORGANIZATION_ALERT_RECIPIENTS + 1))
        .success
    ).toBe(false);
  });

  test('accepts the maximum number of distinct recipients, counted after deduplication', () => {
    const withDuplicates = [
      ...addresses(MAX_ORGANIZATION_ALERT_RECIPIENTS),
      'FINANCE0@example.com',
      ' finance1@example.com ',
    ];

    expect(OrganizationAlertRecipientsSchema.parse(withDuplicates)).toEqual(
      addresses(MAX_ORGANIZATION_ALERT_RECIPIENTS)
    );
  });

  test('allows zero recipients so a disabled alert can drop all disclosure', () => {
    expect(OrganizationAlertRecipientsSchema.parse([])).toEqual([]);
  });
});

describe('EnabledOrganizationAlertRecipientsSchema', () => {
  test('requires at least one recipient', () => {
    expect(EnabledOrganizationAlertRecipientsSchema.safeParse([]).success).toBe(false);
    expect(EnabledOrganizationAlertRecipientsSchema.parse(['Finance@Example.com'])).toEqual([
      'finance@example.com',
    ]);
  });

  test('still enforces the cap', () => {
    expect(
      EnabledOrganizationAlertRecipientsSchema.safeParse(
        addresses(MAX_ORGANIZATION_ALERT_RECIPIENTS + 1)
      ).success
    ).toBe(false);
  });
});
