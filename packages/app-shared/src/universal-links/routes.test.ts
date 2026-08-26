import { describe, expect, it } from 'vitest';

import {
  UNIVERSAL_LINK_ROUTES,
  aasaComponents,
  androidPathPatterns,
  parseKiloWebPath,
  resolveIncomingUrl,
  webPathToAppPath,
} from './routes';

const WEB = 'https://app.kilo.ai';

/** Expected targets for the 16 table rows (concrete ids where wildcards). */
const ROW_CASES = [
  {
    path: '/home',
    app: '/(app)/(tabs)/(0_home)',
  },
  {
    path: '/profile',
    app: '/(app)/(tabs)/(3_profile)',
  },
  {
    path: '/profile/preferences',
    app: '/(app)/(tabs)/(3_profile)/preferences',
  },
  {
    path: '/claw',
    app: '/(app)/(tabs)/(1_kiloclaw)',
  },
  {
    path: '/cloud/sessions',
    app: '/(app)/(tabs)/(2_agents)',
  },
  {
    path: '/cloud/sessions/ses_1',
    app: '/(app)/agent-chat/ses_1',
  },
  {
    path: '/security-agent',
    app: '/(app)/(tabs)/(3_profile)/security-agent/personal',
  },
  {
    path: '/security-agent/findings',
    app: '/(app)/(tabs)/(3_profile)/security-agent/personal/findings',
  },
  {
    path: '/code-reviews',
    app: '/(app)/(tabs)/(3_profile)/code-reviewer/personal',
  },
  {
    path: '/code-reviews/rev_9',
    app: '/(app)/(tabs)/(3_profile)/code-reviewer/personal/reviews/rev_9',
  },
  {
    path: '/organizations/org_123/security-agent',
    app: '/(app)/(tabs)/(3_profile)/security-agent/org_123',
  },
  {
    path: '/organizations/org_123/security-agent/findings',
    app: '/(app)/(tabs)/(3_profile)/security-agent/org_123/findings',
  },
  {
    path: '/organizations/org_123/code-reviews',
    app: '/(app)/(tabs)/(3_profile)/code-reviewer/org_123',
  },
  {
    path: '/organizations/org_123/code-reviews/rev_9',
    app: '/(app)/(tabs)/(3_profile)/code-reviewer/org_123/reviews/rev_9',
  },
  {
    path: '/organizations/org_123/overview',
    app: '/(app)/(tabs)/(3_profile)/organization/org_123',
  },
  {
    path: '/pr-review/acme/api/42',
    app: '/(app)/pr-review/acme/api/42',
  },
] as const;

describe('UNIVERSAL_LINK_ROUTES', () => {
  it('has exactly 16 rows', () => {
    expect(UNIVERSAL_LINK_ROUTES).toHaveLength(16);
  });
});

describe('resolveIncomingUrl — https rows', () => {
  it.each(ROW_CASES)('maps $path', ({ path, app }) => {
    expect(resolveIncomingUrl(`${WEB}${path}`)).toBe(app);
  });
});

describe('resolveIncomingUrl — kiloapp:// forms', () => {
  it.each(ROW_CASES)('maps kiloapp:///$path (empty host)', ({ path, app }) => {
    expect(resolveIncomingUrl(`kiloapp://${path}`)).toBe(app);
  });

  it('maps kiloapp://profile (host carries first segment)', () => {
    expect(resolveIncomingUrl('kiloapp://profile')).toBe('/(app)/(tabs)/(3_profile)');
  });

  it('maps kiloapp://app.kilo.ai/profile', () => {
    expect(resolveIncomingUrl('kiloapp://app.kilo.ai/profile')).toBe('/(app)/(tabs)/(3_profile)');
  });

  it('maps kiloapp://code-reviews/rev_9 (host + path as pathname)', () => {
    expect(resolveIncomingUrl('kiloapp://code-reviews/rev_9')).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/personal/reviews/rev_9'
    );
  });

  it('maps kiloapp:///cloud/sessions', () => {
    expect(resolveIncomingUrl('kiloapp:///cloud/sessions')).toBe('/(app)/(tabs)/(2_agents)');
  });
});

describe('wildcard capture substitution', () => {
  it('row 7: /code-reviews/rev_9', () => {
    expect(resolveIncomingUrl(`${WEB}/code-reviews/rev_9`)).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/personal/reviews/rev_9'
    );
  });

  it('row 8: /organizations/org_123/security-agent', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/security-agent`)).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/org_123'
    );
  });

  it('row 9: /organizations/org_123/security-agent/findings', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/security-agent/findings`)).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/org_123/findings'
    );
  });

  it('row 10: /organizations/org_123/code-reviews', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/code-reviews`)).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/org_123'
    );
  });

  it('row 11: /organizations/org_123/code-reviews/rev_9', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/code-reviews/rev_9`)).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/org_123/reviews/rev_9'
    );
  });

  it('inserts captures literally — dollar substitution patterns stay verbatim', () => {
    // String replacement would run ECMA-262 GetSubstitution on the capture:
    // `$&` re-inserts the placeholder, `$'` splices the un-substituted tail.
    expect(resolveIncomingUrl(`${WEB}/code-reviews/a$&b`)).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/personal/reviews/a$&b'
    );
    expect(resolveIncomingUrl(`${WEB}/organizations/a$'b/code-reviews/rev_9`)).toBe(
      "/(app)/(tabs)/(3_profile)/code-reviewer/a$'b/reviews/rev_9"
    );
    expect(resolveIncomingUrl(`${WEB}/organizations/a$b/code-reviews/rev_9`)).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/a$b/reviews/rev_9'
    );
  });

  it('never rescans inserted captures — a literal <n> in a capture stays verbatim', () => {
    // Per-capture replaceAll passes would substitute the `<2>` inserted for
    // `<1>` again in pass 2. Single-pass substitution must not.
    expect(resolveIncomingUrl('kiloapp:///organizations/<2>/code-reviews/rev_9')).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/<2>/reviews/rev_9'
    );
    expect(resolveIncomingUrl('kiloapp:///organizations/org_1/code-reviews/<1>')).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/org_1/reviews/<1>'
    );
  });
});

describe('exclusions', () => {
  it('excludes /code-reviews/review-md via resolveIncomingUrl', () => {
    expect(resolveIncomingUrl(`${WEB}/code-reviews/review-md`)).toBeNull();
  });

  it('excludes /organizations/o1/code-reviews/review-md via resolveIncomingUrl', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/o1/code-reviews/review-md`)).toBeNull();
  });

  it('excludes via webPathToAppPath', () => {
    expect(webPathToAppPath('/code-reviews/review-md')).toBeNull();
    expect(webPathToAppPath('/organizations/o1/code-reviews/review-md')).toBeNull();
  });
});

describe('wildcard is single-segment', () => {
  it('rejects /code-reviews/a/b', () => {
    expect(resolveIncomingUrl(`${WEB}/code-reviews/a/b`)).toBeNull();
    expect(webPathToAppPath('/code-reviews/a/b')).toBeNull();
  });

  it('rejects /organizations/a/b/security-agent', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/a/b/security-agent`)).toBeNull();
    expect(webPathToAppPath('/organizations/a/b/security-agent')).toBeNull();
  });
});

describe('trailing slash normalisation', () => {
  it('maps /profile/ to row 1', () => {
    expect(resolveIncomingUrl(`${WEB}/profile/`)).toBe('/(app)/(tabs)/(3_profile)');
    expect(parseKiloWebPath(`${WEB}/profile/`)).toBe('/profile');
  });

  it('maps /cloud/sessions/ to row 3', () => {
    expect(resolveIncomingUrl(`${WEB}/cloud/sessions/`)).toBe('/(app)/(tabs)/(2_agents)');
    expect(parseKiloWebPath(`${WEB}/cloud/sessions/`)).toBe('/cloud/sessions');
  });

  it('does not strip more than one trailing slash: /profile// → null', () => {
    // Strip once → "/profile/", which matches nothing.
    expect(parseKiloWebPath(`${WEB}/profile//`)).toBe('/profile/');
    expect(webPathToAppPath('/profile/')).toBeNull();
    expect(resolveIncomingUrl(`${WEB}/profile//`)).toBeNull();
  });
});

describe('deliberately unmapped paths', () => {
  const unmapped = [
    '/users/sign_in',
    '/auth/verify-magic-link',
    '/device-auth',
    '/sign-in-to-editor',
    '/openclaw-advisor',
    '/account-verification',
    '/github-app',
    '/collab',
    '/payments/xyz',
    '/admin/users',
    '/privacy-app',
    '/terms-app',
    '/vscode-marketplace',
    '/claw/chat/conv_1',
    '/s/sess_1',
    '/share/sh_1',
    '/',
    '/login',
  ] as const;

  it.each(unmapped)('%s → null', path => {
    expect(resolveIncomingUrl(`${WEB}${path}`)).toBeNull();
    expect(webPathToAppPath(path)).toBeNull();
  });
});

describe('commerce paths are not universal links', () => {
  it.each(['/kilo-pass', '/credits', '/subscriptions/kilo-pass'])(
    'webPathToAppPath(%s) → null',
    path => {
      expect(webPathToAppPath(path)).toBeNull();
    }
  );
});

describe('foreign / garbage input', () => {
  const garbage = [
    'https://kilo.ai/profile',
    'https://staging-app.kilo.ai/profile',
    'https://evil.example.com/profile',
    'ftp://app.kilo.ai/profile',
    'not a url',
    '',
    'kiloapp://',
  ] as const;

  it.each(garbage)('%j → null, no throw', raw => {
    expect(() => parseKiloWebPath(raw)).not.toThrow();
    expect(parseKiloWebPath(raw)).toBeNull();
    expect(() => resolveIncomingUrl(raw)).not.toThrow();
    expect(resolveIncomingUrl(raw)).toBeNull();
  });
});

describe('parseKiloWebPath', () => {
  it('is case-insensitive for https host', () => {
    expect(parseKiloWebPath('https://APP.KILO.AI/profile')).toBe('/profile');
  });

  it('drops query strings and fragments', () => {
    expect(parseKiloWebPath(`${WEB}/profile?foo=1#bar`)).toBe('/profile');
    expect(parseKiloWebPath(`${WEB}/code-reviews/rev_9?x=1`)).toBe('/code-reviews/rev_9');
  });

  it('leaves percent-encoding as-is', () => {
    expect(parseKiloWebPath(`${WEB}/code-reviews/rev%2F9`)).toBe('/code-reviews/rev%2F9');
  });

  it('rejects www.kilo.ai and other hosts', () => {
    expect(parseKiloWebPath('https://www.kilo.ai/profile')).toBeNull();
  });
});

describe('aasaComponents', () => {
  it('returns 18 entries (16 rows + 2 exclusions)', () => {
    expect(aasaComponents()).toHaveLength(18);
  });

  it('every entry has a "/" key', () => {
    for (const entry of aasaComponents()) {
      expect(entry).toHaveProperty('/');
      expect(typeof entry['/']).toBe('string');
    }
  });

  it('emits exclusion immediately before row 7 (/code-reviews/*)', () => {
    const components = aasaComponents();
    // Rows 1–9 are exact (indices 0–8). Row 10 exclusion then row 10 → indices 9–10.
    expect(components[9]).toEqual({ '/': '/code-reviews/review-md', exclude: true });
    expect(components[10]).toEqual({ '/': '/code-reviews/*' });
  });

  it('emits exclusion immediately before row 14 (/organizations/*/code-reviews/*)', () => {
    const components = aasaComponents();
    // After row 10 pair: rows 11–13 (3 exact) → indices 11,12,13.
    // Row 14 exclusion + row 14 → indices 14–15.
    expect(components[14]).toEqual({
      '/': '/organizations/*/code-reviews/review-md',
      exclude: true,
    });
    expect(components[15]).toEqual({ '/': '/organizations/*/code-reviews/*' });
  });

  it('keeps table * verbatim (Apple glob crosses /)', () => {
    const paths = aasaComponents().map(c => c['/']);
    expect(paths).toContain('/code-reviews/*');
    expect(paths).toContain('/organizations/*/code-reviews/*');
    expect(paths).toContain('/organizations/*/security-agent');
  });
});

describe('androidPathPatterns', () => {
  it('deep-equals the expected 16-string list', () => {
    expect(androidPathPatterns()).toEqual([
      '/home',
      '/profile',
      '/profile/preferences',
      '/claw',
      '/cloud/sessions',
      '/cloud/sessions/.*',
      '/security-agent',
      '/security-agent/findings',
      '/code-reviews',
      '/code-reviews/.*',
      '/organizations/.*/security-agent',
      '/organizations/.*/security-agent/findings',
      '/organizations/.*/code-reviews',
      '/organizations/.*/code-reviews/.*',
      '/organizations/.*/overview',
      '/pr-review/.*/.*/.*',
    ]);
  });
});
