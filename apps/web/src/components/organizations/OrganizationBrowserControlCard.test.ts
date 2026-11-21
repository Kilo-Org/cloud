import { describe, expect, test } from '@jest/globals';
import { MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS } from '@kilocode/db/schema-types';
import { browserControlCardValues } from './OrganizationBrowserControlCard';

describe('browserControlCardValues', () => {
  test('shows the organization default when no policy is stored', () => {
    expect(browserControlCardValues(undefined)).toEqual({
      browserControl: 'allow',
      browserAllowedOrigins: [],
      controlUnreadable: false,
    });
    expect(browserControlCardValues({})).toEqual({
      browserControl: 'allow',
      browserAllowedOrigins: [],
      controlUnreadable: false,
    });
  });

  test('shows the stored policy clients enforce', () => {
    expect(
      browserControlCardValues({
        browserControl: 'playwright_only',
        browserAllowedOrigins: ['https://example.com'],
      })
    ).toEqual({
      browserControl: 'playwright_only',
      browserAllowedOrigins: ['https://example.com'],
      controlUnreadable: false,
    });
  });

  test('shows Off and flags the stored value when the stored mode is unreadable', () => {
    expect(browserControlCardValues({ browserControl: 'ask' })).toEqual({
      browserControl: 'off',
      browserAllowedOrigins: [],
      controlUnreadable: true,
    });
  });

  test('shows only the origins clients accept', () => {
    expect(
      browserControlCardValues({
        browserControl: 'allow',
        browserAllowedOrigins: ['https://example.com/checkout', 'https://ok.example'],
      })
    ).toEqual({
      browserControl: 'allow',
      browserAllowedOrigins: ['https://ok.example'],
      controlUnreadable: false,
    });
  });

  test('caps a stored origin list at what a save accepts', () => {
    const stored = Array.from(
      { length: MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS + 3 },
      (_, index) => `https://site-${index}.example`
    );

    const values = browserControlCardValues({
      browserControl: 'allow',
      browserAllowedOrigins: stored,
    });

    expect(values.browserAllowedOrigins).toHaveLength(MAX_ORGANIZATION_BROWSER_ALLOWED_ORIGINS);
    expect(values.controlUnreadable).toBe(false);
  });
});
