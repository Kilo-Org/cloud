import {
  GOOGLE_CAPABILITY,
  GOOGLE_IDENTITY_SCOPES,
  hasRequiredScopesForCapabilities,
  parseGoogleCapabilities,
  parseGoogleScopeString,
  resolveGoogleScopesForCapabilities,
} from './capabilities';

describe('google capabilities', () => {
  test('parseGoogleCapabilities falls back to default when query is empty', () => {
    expect(parseGoogleCapabilities(null)).toEqual([GOOGLE_CAPABILITY.CALENDAR_READ]);
    expect(parseGoogleCapabilities('')).toEqual([GOOGLE_CAPABILITY.CALENDAR_READ]);
  });

  test('parseGoogleCapabilities parses and deduplicates comma-separated values', () => {
    expect(parseGoogleCapabilities('calendar_read,gmail_read,drive_read,calendar_read')).toEqual([
      GOOGLE_CAPABILITY.CALENDAR_READ,
      GOOGLE_CAPABILITY.GMAIL_READ,
      GOOGLE_CAPABILITY.DRIVE_READ,
    ]);
  });

  test('resolveGoogleScopesForCapabilities always includes identity scopes', () => {
    const scopes = resolveGoogleScopesForCapabilities([GOOGLE_CAPABILITY.CALENDAR_READ]);

    for (const identityScope of GOOGLE_IDENTITY_SCOPES) {
      expect(scopes).toContain(identityScope);
    }

    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.readonly');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/drive.readonly');
  });

  test('hasRequiredScopesForCapabilities validates required scopes', () => {
    const grantedScopes = resolveGoogleScopesForCapabilities([
      GOOGLE_CAPABILITY.CALENDAR_READ,
      GOOGLE_CAPABILITY.GMAIL_READ,
      GOOGLE_CAPABILITY.DRIVE_READ,
    ]);

    expect(hasRequiredScopesForCapabilities(grantedScopes, [GOOGLE_CAPABILITY.CALENDAR_READ])).toBe(
      true
    );
    expect(hasRequiredScopesForCapabilities(grantedScopes, [GOOGLE_CAPABILITY.GMAIL_READ])).toBe(
      true
    );
    expect(hasRequiredScopesForCapabilities(grantedScopes, [GOOGLE_CAPABILITY.DRIVE_READ])).toBe(
      true
    );
    expect(
      hasRequiredScopesForCapabilities(
        resolveGoogleScopesForCapabilities([GOOGLE_CAPABILITY.CALENDAR_READ]),
        [GOOGLE_CAPABILITY.GMAIL_READ]
      )
    ).toBe(false);
  });

  test('parseGoogleScopeString handles empty input and normalizes output', () => {
    expect(parseGoogleScopeString(undefined)).toEqual([]);
    expect(parseGoogleScopeString('')).toEqual([]);
    expect(parseGoogleScopeString('b a b')).toEqual(['a', 'b']);
  });
});
