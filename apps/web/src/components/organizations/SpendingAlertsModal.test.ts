import { describe, expect, test } from '@jest/globals';
import { resolveNotificationEmails } from './spending-alerts-form';

describe('resolveNotificationEmails', () => {
  test('uses a valid pending email as the first recipient', () => {
    expect(resolveNotificationEmails([], ' billing@example.com ')).toEqual(['billing@example.com']);
  });

  test('adds a valid pending email to existing recipients', () => {
    expect(resolveNotificationEmails(['owner@example.com'], 'billing@example.com')).toEqual([
      'owner@example.com',
      'billing@example.com',
    ]);
  });

  test('does not add a duplicate pending email', () => {
    expect(resolveNotificationEmails(['billing@example.com'], ' billing@example.com ')).toEqual([
      'billing@example.com',
    ]);
  });

  test('rejects a non-empty invalid pending email', () => {
    expect(resolveNotificationEmails(['owner@example.com'], 'not-an-email')).toBeNull();
  });

  test('keeps existing recipients when the input is empty', () => {
    expect(resolveNotificationEmails(['owner@example.com'], '  ')).toEqual(['owner@example.com']);
  });
});
