import { describe, expect, test } from '@jest/globals';
import { MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS } from '@kilocode/db/schema-types';
import {
  DEFAULT_ORGANIZATION_BROWSER_POLICY,
  inspectOrganizationBrowserPolicy,
  resolveOrganizationBrowserPolicy,
} from './browser-policy';

function organizationWith(settings: unknown) {
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
    expect(resolveOrganizationBrowserPolicy(organizationWith({ browserControl: 'ask' }))).toEqual({
      browserControl: 'off',
      browserAllowedOrigins: [],
    });
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
    const settings = {
      default_model: 'anthropic/claude-sonnet-4',
      browserControl: 'off',
    };
    expect(resolveOrganizationBrowserPolicy(organizationWith(settings))).toEqual({
      browserControl: 'off',
      browserAllowedOrigins: [],
    });
  });

  test('stops accepting origins once the list reaches the stored maximum', () => {
    const stored = Array.from(
      { length: MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS + 5 },
      (_, index) => `https://site-${index}.example`
    );

    const policy = resolveOrganizationBrowserPolicy(
      organizationWith({ browserControl: 'playwright_only', browserAllowedOrigins: stored })
    );

    expect(policy.browserControl).toBe('playwright_only');
    expect(policy.browserAllowedOrigins).toHaveLength(MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS);
    expect(policy.browserAllowedOrigins[0]).toBe('https://site-0.example');
    expect(policy.browserAllowedOrigins.at(-1)).toBe(
      `https://site-${MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS - 1}.example`
    );
  });
});

describe('inspectOrganizationBrowserPolicy', () => {
  test('reports an absent control mode without flagging the stored value', () => {
    expect(inspectOrganizationBrowserPolicy(organizationWith({}))).toEqual({
      policy: { browserControl: 'allow', browserAllowedOrigins: [] },
      storedControl: 'absent',
    });
  });

  test('reports a readable stored control mode', () => {
    expect(
      inspectOrganizationBrowserPolicy(organizationWith({ browserControl: 'off' })).storedControl
    ).toBe('readable');
  });

  test('reports an unreadable stored control mode next to the enforced off policy', () => {
    expect(inspectOrganizationBrowserPolicy(organizationWith({ browserControl: 'ask' }))).toEqual({
      policy: { browserControl: 'off', browserAllowedOrigins: [] },
      storedControl: 'unreadable',
    });
  });

  test('agrees with the resolver it backs', () => {
    const settings = {
      browserControl: 'playwright_only',
      browserAllowedOrigins: ['https://example.com/checkout', 'https://ok.example'],
    };
    expect(inspectOrganizationBrowserPolicy(organizationWith(settings)).policy).toEqual(
      resolveOrganizationBrowserPolicy(organizationWith(settings))
    );
  });
});
