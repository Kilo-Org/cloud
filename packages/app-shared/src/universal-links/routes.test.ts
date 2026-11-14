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
    path: '/credits',
    app: '/(app)/(tabs)/(3_profile)/credit-history',
  },
  {
    path: '/usage',
    app: '/(app)/usage',
  },
  {
    path: '/invoices',
    app: '/(app)/(tabs)/(3_profile)/invoices',
  },
  {
    path: '/data-exports',
    app: '/(app)/(tabs)/(3_profile)/data-export',
  },
  {
    path: '/byok',
    app: '/(app)/(tabs)/(3_profile)/provider-keys',
  },
  {
    path: '/integrations',
    app: '/(app)/(tabs)/(3_profile)/integrations',
  },
  {
    path: '/subscriptions/kilo-pass',
    app: '/(app)/kilo-pass',
  },
  {
    path: '/security-agent/config',
    app: '/(app)/security-agent/personal/settings',
  },
  {
    path: '/organizations/org_123/security-agent/config',
    app: '/(app)/security-agent/org_123/settings',
  },
  {
    path: '/organizations/org_123/integrations',
    app: '/(app)/(tabs)/(3_profile)/integrations?org=org_123',
  },
  {
    path: '/organizations/org_123/usage-details',
    app: '/(app)/(tabs)/(3_profile)/organization/usage?org=org_123',
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
    app: '/(app)/security-agent/personal',
  },
  {
    path: '/security-agent/findings',
    app: '/(app)/security-agent/personal/findings',
  },
  {
    path: '/code-reviews',
    app: '/(app)/code-reviewer/personal',
  },
  {
    path: '/code-reviews/rev_9',
    app: '/(app)/code-reviewer/personal/reviews/rev_9',
  },
  {
    path: '/organizations/org_123/security-agent',
    app: '/(app)/security-agent/org_123',
  },
  {
    path: '/organizations/org_123/security-agent/findings',
    app: '/(app)/security-agent/org_123/findings',
  },
  {
    path: '/organizations/org_123/code-reviews',
    app: '/(app)/code-reviewer/org_123',
  },
  {
    path: '/organizations/org_123/code-reviews/rev_9',
    app: '/(app)/code-reviewer/org_123/reviews/rev_9',
  },
  {
    path: '/organizations/org_123/overview',
    app: '/(app)/(tabs)/(3_profile)/organization/org_123',
  },
  {
    path: '/pr-review/gitlab/acme/api/42',
    app: '/(app)/pr-review/gitlab/acme/api/42',
  },
  {
    path: '/pr-review/bitbucket/acme/api/42',
    app: '/(app)/pr-review/bitbucket/acme/api/42',
  },
  {
    path: '/pr-review/acme/api/42',
    app: '/(app)/pr-review/acme/api/42',
  },
  {
    path: '/s/share-token-opaque',
    app: '/(app)/shared/share-token-opaque',
  },
] as const;

describe('UNIVERSAL_LINK_ROUTES', () => {
  it('has exactly 30 rows', () => {
    expect(UNIVERSAL_LINK_ROUTES).toHaveLength(30);
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
      '/(app)/code-reviewer/personal/reviews/rev_9'
    );
  });

  it('maps kiloapp:///cloud/sessions', () => {
    expect(resolveIncomingUrl('kiloapp:///cloud/sessions')).toBe('/(app)/(tabs)/(2_agents)');
  });
});

describe('wildcard capture substitution', () => {
  it('row 7: /code-reviews/rev_9', () => {
    expect(resolveIncomingUrl(`${WEB}/code-reviews/rev_9`)).toBe(
      '/(app)/code-reviewer/personal/reviews/rev_9'
    );
  });

  it('row 8: /organizations/org_123/security-agent', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/security-agent`)).toBe(
      '/(app)/security-agent/org_123'
    );
  });

  it('row 9: /organizations/org_123/security-agent/findings', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/security-agent/findings`)).toBe(
      '/(app)/security-agent/org_123/findings'
    );
  });

  it('row 10: /organizations/org_123/code-reviews', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/code-reviews`)).toBe(
      '/(app)/code-reviewer/org_123'
    );
  });

  it('row 11: /organizations/org_123/code-reviews/rev_9', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/code-reviews/rev_9`)).toBe(
      '/(app)/code-reviewer/org_123/reviews/rev_9'
    );
  });

  it('row 12: /organizations/org_123 — the dashboard an accepted invite lands on', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123`)).toBe(
      '/(app)/(tabs)/(3_profile)/organization/org_123'
    );
  });

  it('row 12b: /organizations/org_123/overview keeps its own row', () => {
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/overview`)).toBe(
      '/(app)/(tabs)/(3_profile)/organization/org_123'
    );
  });

  it('keeps the organization create pages in the browser', () => {
    // `/organizations/new` matches the bare row's shape but is the web create
    // form, which must open where the account is asked to sign in.
    expect(resolveIncomingUrl(`${WEB}/organizations/new`)).toBeNull();
    expect(resolveIncomingUrl(`${WEB}/organizations/create`)).toBeNull();
    expect(webPathToAppPath('/organizations/new')).toBeNull();
    expect(webPathToAppPath('/organizations/create')).toBeNull();
  });

  it('keeps every deeper organization page in the browser', () => {
    // `/organizations/<id>` is the only deep org target the app owns; the rest
    // of the web dashboard (SSO, guardrails, request logs, members, …) is
    // web-only, and one broad association would hijack it on every phone.
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/guardrails`)).toBeNull();
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/sso`)).toBeNull();
    expect(resolveIncomingUrl(`${WEB}/organizations/org_123/request-logs`)).toBeNull();
    expect(webPathToAppPath('/organizations/org_123/guardrails')).toBeNull();
    expect(webPathToAppPath('/organizations/org_123/sso')).toBeNull();
  });

  it('inserts captures literally — dollar substitution patterns stay verbatim', () => {
    // String replacement would run ECMA-262 GetSubstitution on the capture:
    // `$&` re-inserts the placeholder, `$'` splices the un-substituted tail.
    expect(resolveIncomingUrl(`${WEB}/code-reviews/a$&b`)).toBe(
      '/(app)/code-reviewer/personal/reviews/a$&b'
    );
    expect(resolveIncomingUrl(`${WEB}/organizations/a$'b/code-reviews/rev_9`)).toBe(
      "/(app)/code-reviewer/a$'b/reviews/rev_9"
    );
    expect(resolveIncomingUrl(`${WEB}/organizations/a$b/code-reviews/rev_9`)).toBe(
      '/(app)/code-reviewer/a$b/reviews/rev_9'
    );
  });

  it('never rescans inserted captures — a literal <n> in a capture stays verbatim', () => {
    // Per-capture replaceAll passes would substitute the `<2>` inserted for
    // `<1>` again in pass 2. Single-pass substitution must not.
    expect(resolveIncomingUrl('kiloapp:///organizations/<2>/code-reviews/rev_9')).toBe(
      '/(app)/code-reviewer/<2>/reviews/rev_9'
    );
    expect(resolveIncomingUrl('kiloapp:///organizations/org_1/code-reviews/<1>')).toBe(
      '/(app)/code-reviewer/org_1/reviews/<1>'
    );
  });
});

describe('trailing ** rows (provider PR paths, s7)', () => {
  it('joins a multi-segment GitLab project path into one capture', () => {
    expect(resolveIncomingUrl(`${WEB}/pr-review/gitlab/group/sub/repo/123`)).toBe(
      '/(app)/pr-review/gitlab/group/sub/repo/123'
    );
  });

  it('matches the shortest tail — one segment', () => {
    expect(resolveIncomingUrl(`${WEB}/pr-review/bitbucket/acme/42`)).toBe(
      '/(app)/pr-review/bitbucket/acme/42'
    );
  });

  it('beats the GitHub row on a same-length path — the literal platform wins', () => {
    // `/pr-review/gitlab/x/123` has the GitHub row's segment count; it must
    // NOT be read as owner "gitlab".
    expect(resolveIncomingUrl(`${WEB}/pr-review/gitlab/x/123`)).toBe(
      '/(app)/pr-review/gitlab/x/123'
    );
  });

  it('requires one-or-more tail segments — a bare platform prefix maps to nothing', () => {
    expect(resolveIncomingUrl(`${WEB}/pr-review/gitlab`)).toBeNull();
    expect(webPathToAppPath('/pr-review/bitbucket')).toBeNull();
  });

  it('does not match other platform prefixes', () => {
    expect(resolveIncomingUrl(`${WEB}/pr-review/gitlab.example/g/r/1`)).toBeNull();
  });

  it('inserts the joined tail literally — dollar patterns stay verbatim', () => {
    expect(resolveIncomingUrl(`${WEB}/pr-review/gitlab/a$&b/c/1`)).toBe(
      '/(app)/pr-review/gitlab/a$&b/c/1'
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
    '/payments/xyz',
    '/admin/users',
    '/privacy-app',
    '/terms-app',
    '/vscode-marketplace',
    '/claw',
    '/claw/chat/conv_1',
    // The legacy `/share/<shareId>` blob viewer stays on the web: mobile has no
    // v1 transcript renderer, and the link opens in the browser instead.
    '/share/sh_1',
    '/',
    '/login',
    // Sub-paths of the account rows above: the app shows the hub page, never a
    // per-service detail page, so these stay on the web. A literal row matches
    // exactly, so no exclusion is needed for them.
    '/integrations/slack',
    '/integrations/linear',
    '/integrations/linear/reinstall',
    '/subscriptions/kilo-pass/refer',
    '/subscriptions/coding-plans',
    '/security-agent/audit-report',
    // Organization pages with no screen in the app. BYOK, members and invoices
    // are cards or web-only pages (the org's invoices live on the multi-card
    // `/organizations/<id>/payment-details`), so their links open the web.
    '/organizations/org_123/byok',
    '/organizations/org_123/members',
    '/organizations/org_123/payment-details',
    '/organizations/org_123/integrations/linear',
    '/organizations/org_123/security-agent/audit-report',
  ] as const;

  it.each(unmapped)('%s → null', path => {
    expect(resolveIncomingUrl(`${WEB}${path}`)).toBeNull();
    expect(webPathToAppPath(path)).toBeNull();
  });
});

describe('commerce paths', () => {
  it('maps the account pages the app owns to their native screens', () => {
    // These were deliberately unmapped while the app had no screen for them;
    // the credit history, the Kilo Pass manager and the purchase modal are
    // native now, so the web pages open them instead of a dead web view.
    expect(webPathToAppPath('/credits')).toBe('/(app)/(tabs)/(3_profile)/credit-history');
    expect(webPathToAppPath('/subscriptions/kilo-pass')).toBe('/(app)/kilo-pass');
  });

  it('keeps /kilo-pass unmapped — the app has no web page for it', () => {
    // `/kilo-pass` is not a page of the web app; the row above is the
    // `/subscriptions/kilo-pass` page, which the app answers natively.
    expect(webPathToAppPath('/kilo-pass')).toBeNull();
  });
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

  // Userinfo hides a foreign host after the first `:` (`app.kilo.ai:pass@evil.com`),
  // so an authority carrying `@` is rejected before the host is read.
  it('rejects userinfo in the authority', () => {
    expect(parseKiloWebPath('https://app.kilo.ai:pass@evil.com/profile')).toBeNull();
    expect(parseKiloWebPath('https://user@app.kilo.ai/profile')).toBeNull();
    expect(resolveIncomingUrl('https://app.kilo.ai:pass@evil.com/organizations/org_1')).toBeNull();
  });

  it('accepts a numeric port and rejects a non-numeric one', () => {
    expect(parseKiloWebPath('https://app.kilo.ai:443/profile')).toBe('/profile');
    expect(parseKiloWebPath('https://app.kilo.ai:not_a_port/profile')).toBeNull();
  });
});

describe('aasaComponents', () => {
  it('returns 35 entries (30 rows + 5 exclusions)', () => {
    expect(aasaComponents()).toHaveLength(35);
  });

  it('every entry has a "/" key', () => {
    for (const entry of aasaComponents()) {
      expect(entry).toHaveProperty('/');
      expect(typeof entry['/']).toBe('string');
    }
  });

  it('emits exclusion immediately before /code-reviews/*', () => {
    const components = aasaComponents();
    const row = components.findIndex(c => c['/'] === '/code-reviews/*');
    expect(components[row - 1]).toEqual({ '/': '/code-reviews/review-md', exclude: true });
    expect(components[row]).toEqual({ '/': '/code-reviews/*' });
  });

  it('emits exclusion immediately before /organizations/*/code-reviews/*', () => {
    const components = aasaComponents();
    const row = components.findIndex(c => c['/'] === '/organizations/*/code-reviews/*');
    expect(components[row - 1]).toEqual({
      '/': '/organizations/*/code-reviews/review-md',
      exclude: true,
    });
    expect(components[row]).toEqual({ '/': '/organizations/*/code-reviews/*' });
  });

  it('excludes the organization create paths before the bare organization row', () => {
    const components = aasaComponents();
    const paths = components.map(c => c['/']);
    const bare = paths.indexOf('/organizations/*');
    expect(bare).toBeGreaterThan(0);
    expect(paths.slice(0, bare)).toEqual(
      expect.arrayContaining(['/organizations/new', '/organizations/create'])
    );
    const created = components.filter(
      c => c['/'] === '/organizations/new' || c['/'] === '/organizations/create'
    );
    expect(created).toHaveLength(2);
    for (const entry of created) {
      expect(entry).toMatchObject({ exclude: true });
    }
  });

  it('excludes deeper organization paths immediately before the bare row', () => {
    // Apple's `*` crosses `/`, so `/organizations/*` alone would associate
    // every web-only org subpage. The exclusion must sit after the app-owned
    // deeper rows (first match wins) and before the bare row.
    const components = aasaComponents();
    const paths = components.map(c => c['/']);
    const deeperExclude = paths.indexOf('/organizations/*/*');
    const bare = paths.indexOf('/organizations/*');
    expect(deeperExclude).toBe(bare - 1);
    expect(components[deeperExclude]).toEqual({ '/': '/organizations/*/*', exclude: true });

    for (const handled of [
      '/organizations/*/security-agent',
      '/organizations/*/security-agent/findings',
      '/organizations/*/security-agent/config',
      '/organizations/*/code-reviews',
      '/organizations/*/code-reviews/*',
      '/organizations/*/overview',
      '/organizations/*/integrations',
      '/organizations/*/usage-details',
    ]) {
      const index = paths.indexOf(handled);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(deeperExclude);
    }
  });

  it('keeps table * verbatim (Apple glob crosses /)', () => {
    const paths = aasaComponents().map(c => c['/']);
    expect(paths).toContain('/code-reviews/*');
    expect(paths).toContain('/organizations/*/code-reviews/*');
    expect(paths).toContain('/organizations/*/security-agent');
    expect(paths).toContain('/organizations/*');
    // '**' is two Apple globs — still a glob that crosses /, so the tail
    // rows stay valid AASA output unchanged.
    expect(paths).toContain('/pr-review/gitlab/**');
    expect(paths).toContain('/pr-review/bitbucket/**');
  });
});

describe('androidPathPatterns', () => {
  it('deep-equals the expected mobile path list', () => {
    expect(androidPathPatterns()).toEqual([
      '/home',
      '/profile',
      '/profile/preferences',
      '/credits',
      '/usage',
      '/invoices',
      '/data-exports',
      '/byok',
      '/integrations',
      '/subscriptions/kilo-pass',
      '/cloud/sessions',
      '/cloud/sessions/.*',
      '/security-agent',
      '/security-agent/findings',
      '/security-agent/config',
      '/code-reviews',
      '/code-reviews/.*',
      '/organizations/.*/security-agent',
      '/organizations/.*/security-agent/findings',
      '/organizations/.*/security-agent/config',
      '/organizations/.*/code-reviews',
      '/organizations/.*/code-reviews/.*',
      '/organizations/.*/overview',
      '/organizations/.*/integrations',
      '/organizations/.*/usage-details',
      // The only row that departs from the `.*` compile: it must match one
      // segment, or the Android filter swallows every web-only org page.
      '/organizations/[^/]+',
      '/pr-review/gitlab/.*',
      '/pr-review/bitbucket/.*',
      '/pr-review/.*/.*/.*',
      '/s/.*',
    ]);
  });

  it('compiles every literal account row to a literal pattern', () => {
    // Android matches the whole path, so a literal row claims that page and
    // nothing below it: `/integrations/slack` stays in the browser although the
    // app owns `/integrations`.
    const patterns = androidPathPatterns();
    for (const literal of [
      '/credits',
      '/usage',
      '/invoices',
      '/data-exports',
      '/byok',
      '/integrations',
      '/subscriptions/kilo-pass',
      '/security-agent/config',
    ]) {
      expect(patterns).toContain(literal);
    }
  });

  it('departs from the `.*` compile on the bare organization row only', () => {
    // Every other row keeps the pattern it shipped with; a global `[^/]+`
    // would strangle rows that legitimately cross segments (GitLab project
    // paths, session ids) and stop links that open the app today.
    const overrides = UNIVERSAL_LINK_ROUTES.filter(route => route.androidPathPattern != null);
    expect(overrides.map(route => route.webPath)).toEqual(['/organizations/*']);

    const patterns = androidPathPatterns();
    expect(patterns).not.toContain('/organizations/.*');
    expect(patterns).toContain('/organizations/[^/]+');
    for (const [index, route] of UNIVERSAL_LINK_ROUTES.entries()) {
      if (route.androidPathPattern != null) {
        continue;
      }
      const legacy = route.webPath
        .split('/')
        .map(seg => (seg === '*' || seg === '**' ? '.*' : seg))
        .join('/');
      expect(patterns[index]).toBe(legacy);
    }
  });
});
