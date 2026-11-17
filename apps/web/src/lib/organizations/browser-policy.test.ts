import { describe, expect, test } from '@jest/globals';
import type { Organization } from '@kilocode/db/schema';
import {
  DEFAULT_ORGANIZATION_BROWSER_POLICY,
  resolveOrganizationBrowserPolicy,
} from './browser-policy';

type Settings = Organization['settings'];

function organizationWith(settings: unknown) {
  return { settings } as Pick<Organization, 'settings'>;
}

describe('resolveOrganizationBrowserPolicy', () => {
  test('defaults to allowing browser control with no organization origins', () => {
    expect(resolveOrganizationBrowserPolicy(organizationWith({}))).toEqual(
      DEFAULT_ORGANIZATION_BROWSER_POLICY
    );
    expect(DEFAULT_ORGANIZATION_BROWSER_POLICY).toEqual({
      browserControl: 'allow',
      browserAllowedOrigins: [],
    });
  });

  test('returns the stored control mode and origins', () => {
    expect(
      resolveOrganizationBrowserPolicy(
        organizationWith({
          browserControl: 'playwright_only',
          browserAllowedOrigins: ['https://example.com', 'http://localhost:3000'],
        })
      )
    ).toEqual({
      browserControl: 'playwright_only',
      browserAllowedOrigins: ['https://example.com', 'http://localhost:3000'],
    });
  });

  test('keeps a stored off mode', () => {
    expect(
      resolveOrganizationBrowserPolicy(organizationWith({ browserControl: 'off' })).browserControl
    ).toBe('off');
  });

  test('keeps the control mode when a stored origin is unreadable', () => {
    expect(
      resolveOrganizationBrowserPolicy(
        organizationWith({
          browserControl: 'off',
          browserAllowedOrigins: ['https://example.com/checkout'],
        })
      )
    ).toEqual({ browserControl: 'off', browserAllowedOrigins: [] });
  });

  test('drops unreadable origins individually and keeps the rest', () => {
    expect(
      resolveOrganizationBrowserPolicy(
        organizationWith({
          browserAllowedOrigins: [
            'https://example.com/checkout',
            'https://ok.example',
            'not an origin',
            'http://localhost:3000/',
          ],
        })
      )
    ).toEqual({
      browserControl: 'allow',
      browserAllowedOrigins: ['https://ok.example', 'http://localhost:3000'],
    });
  });

  test('deduplicates origins that normalize to the same value', () => {
    expect(
      resolveOrganizationBrowserPolicy(
        organizationWith({ browserAllowedOrigins: ['https://example.com/', 'https://EXAMPLE.com'] })
      ).browserAllowedOrigins
    ).toEqual(['https://example.com']);
  });

  test('treats an unreadable origins value as no origins but keeps the control mode', () => {
    expect(
      resolveOrganizationBrowserPolicy(
        organizationWith({
          browserControl: 'playwright_only',
          browserAllowedOrigins: 'https://example.com',
        })
      )
    ).toEqual({ browserControl: 'playwright_only', browserAllowedOrigins: [] });
  });

  test('fails closed to off when a stored control mode is unreadable', () => {
    expect(
      resolveOrganizationBrowserPolicy(organizationWith({ browserControl: 'ask' }))
    ).toEqual({ browserControl: 'off', browserAllowedOrigins: [] });
  });

  test('fails closed to off for a non-string stored control mode', () => {
    expect(
      resolveOrganizationBrowserPolicy(organizationWith({ browserControl: 1 })).browserControl
    ).toBe('off');
  });

  test('treats a null or non-object settings row as no stored policy', () => {
    const expected = { browserControl: 'allow', browserAllowedOrigins: [] };
    expect(resolveOrganizationBrowserPolicy(organizationWith(null))).toEqual(expected);
    expect(resolveOrganizationBrowserPolicy(organizationWith('not settings'))).toEqual(expected);
    expect(resolveOrganizationBrowserPolicy(organizationWith([1, 2]))).toEqual(expected);
  });

  test('ignores unrelated settings', () => {
    const settings: Settings = { default_model: 'anthropic/claude-sonnet-4', browserControl: 'off' };
    expect(resolveOrganizationBrowserPolicy(organizationWith(settings))).toEqual({
      browserControl: 'off',
      browserAllowedOrigins: [],
    });
  });
});
