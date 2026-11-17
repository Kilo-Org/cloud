import { describe, expect, test } from '@jest/globals';
import type { Organization } from '@kilocode/db/schema';
import {
  DEFAULT_ORGANIZATION_BROWSER_POLICY,
  resolveOrganizationBrowserPolicy,
} from './browser-policy';

type SettingsOrganization = Pick<Organization, 'settings'>;

function organizationWith(settings: Organization['settings']): SettingsOrganization {
  return { settings };
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

  test('defaults a stored control mode of off', () => {
    expect(
      resolveOrganizationBrowserPolicy(organizationWith({ browserControl: 'off' })).browserControl
    ).toBe('off');
  });

  test('falls back to the defaults when the stored policy is unreadable', () => {
    const stored = {
      browserControl: 'ask',
      browserAllowedOrigins: ['https://example.com/checkout'],
    } as unknown as Organization['settings'];

    expect(resolveOrganizationBrowserPolicy(organizationWith(stored))).toEqual(
      DEFAULT_ORGANIZATION_BROWSER_POLICY
    );
  });

  test('ignores unrelated settings', () => {
    expect(
      resolveOrganizationBrowserPolicy(
        organizationWith({ default_model: 'anthropic/claude-sonnet-4', browserControl: 'off' })
      )
    ).toEqual({ browserControl: 'off', browserAllowedOrigins: [] });
  });
});
