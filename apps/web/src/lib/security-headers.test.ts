import {
  buildContentSecurityPolicy,
  getConfiguredConnectSrcOrigins,
  getContentSecurityPolicyHeaderName,
  getContentSecurityPolicyMode,
  getSecurityPolicyReportingHeaders,
  getSentrySecurityReportUri,
} from '@/lib/security-headers';

describe('security headers', () => {
  it('builds CSP with required third-party sources', () => {
    const policy = buildContentSecurityPolicy({
      connectSrcUrls: ['wss://cloud-agent.example.com/socket'],
    });

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain('https://js.stripe.com');
    expect(policy).toContain('https://*.js.stripe.com');
    expect(policy).toContain('https://api.stripe.com');
    expect(policy).toContain('https://hooks.stripe.com');
    expect(policy).toContain('https://login.kilo.ai');
    expect(policy).toContain('https://login-test.kilo.ai');
    expect(policy).toContain('https://www.googletagmanager.com');
    expect(policy).toContain('https://utt.impactcdn.com');
    expect(policy).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(policy).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(policy).toContain('https://widget.usepylon.com');
    expect(policy).toContain('https://assets.churnkey.co');
    expect(policy).toContain('https://api.churnkey.co');
    expect(policy).toContain('https://*.churnkey.co');
    expect(policy).toContain('https://www.gravatar.com');
    expect(policy).toContain('https://secure.gravatar.com');
    expect(policy).toContain('https://gravatar.com');
    expect(policy).toContain('https://media.licdn.com');
    expect(policy).toContain('https://cdn.discordapp.com');
    expect(policy).toContain('https://gitlab.com');
    expect(policy).toContain('https://openrouter.ai');
    expect(policy).toContain('https://cdn.jsdelivr.net');
    expect(policy).toContain('https://unpkg.com');
    expect(policy).toContain('https://*.d.kiloapps.io');
    expect(policy).toContain('https://www.youtube.com');
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).toContain('wss://cloud-agent.example.com');
  });

  it('aligns Turnstile CSP sources with Cloudflare documentation', () => {
    const policy = buildContentSecurityPolicy();

    expect(policy).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(policy).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(policy).toMatch(/connect-src [^;]*'self'/);
    expect(policy).not.toMatch(/connect-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(policy).not.toMatch(/img-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  });

  it('adds development-only sources only in development mode', () => {
    const productionPolicy = buildContentSecurityPolicy({ isDevelopment: false });
    const developmentPolicy = buildContentSecurityPolicy({ isDevelopment: true });

    expect(productionPolicy).not.toContain("'unsafe-eval'");
    expect(productionPolicy).not.toContain('ws://localhost:*');
    expect(developmentPolicy).toContain("'unsafe-eval'");
    expect(developmentPolicy).toContain('ws://localhost:*');
  });

  it('derives configured connect-src origins from public URLs', () => {
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_CLOUD_AGENT_WS_URL: 'wss://agent.example.com/path',
      NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL: 'wss://next-agent.example.com/path',
      NEXT_PUBLIC_SESSION_INGEST_WS_URL: 'wss://ingest.example.com/path',
      NEXT_PUBLIC_GASTOWN_URL: 'https://gastown.example.com/api',
      NEXT_PUBLIC_SENTRY_DSN:
        'https://27ef80847dcd5e044283c8f88d95ffc9@o4509356317474816.ingest.us.sentry.io/4509565130637312',
    };

    expect(getConfiguredConnectSrcOrigins(env)).toEqual([
      'wss://agent.example.com',
      'wss://next-agent.example.com',
      'wss://ingest.example.com',
      'https://gastown.example.com',
      'wss://gastown.example.com',
      'https://o4509356317474816.ingest.us.sentry.io',
    ]);
  });

  it('derives ws:// Gastown origins for non-HTTPS development URLs', () => {
    expect(
      getConfiguredConnectSrcOrigins({
        NEXT_PUBLIC_GASTOWN_URL: 'http://localhost:8787/api',
      })
    ).toEqual(['http://localhost:8787', 'ws://localhost:8787']);
  });

  it('adds Sentry security policy reporting directives when DSN is configured', () => {
    const policy = buildContentSecurityPolicy({
      env: {
        NEXT_PUBLIC_SENTRY_DSN:
          'https://27ef80847dcd5e044283c8f88d95ffc9@o4509356317474816.ingest.us.sentry.io/4509565130637312',
        SENTRY_ENVIRONMENT: 'production',
        SENTRY_RELEASE: 'web-2026-04-24',
      },
    });

    const reportUri =
      'https://o4509356317474816.ingest.us.sentry.io/api/4509565130637312/security/?sentry_key=27ef80847dcd5e044283c8f88d95ffc9&sentry_environment=production&sentry_release=web-2026-04-24';

    expect(policy).toContain(`report-uri ${reportUri}`);
    expect(policy).toContain('report-to csp-endpoint');
    expect(policy).toContain('https://o4509356317474816.ingest.us.sentry.io');
  });

  it('builds Sentry security policy reporting headers', () => {
    const reportUri = getSentrySecurityReportUri({
      NEXT_PUBLIC_SENTRY_DSN:
        'https://27ef80847dcd5e044283c8f88d95ffc9@o4509356317474816.ingest.us.sentry.io/4509565130637312',
      VERCEL_ENV: 'preview',
    });

    expect(reportUri).toBe(
      'https://o4509356317474816.ingest.us.sentry.io/api/4509565130637312/security/?sentry_key=27ef80847dcd5e044283c8f88d95ffc9&sentry_environment=preview'
    );

    const headers = getSecurityPolicyReportingHeaders({
      NEXT_PUBLIC_SENTRY_DSN:
        'https://27ef80847dcd5e044283c8f88d95ffc9@o4509356317474816.ingest.us.sentry.io/4509565130637312',
      VERCEL_ENV: 'preview',
    });

    expect(headers['Reporting-Endpoints']).toBe(`csp-endpoint="${reportUri}"`);
    expect(JSON.parse(headers['Report-To'] ?? '')).toEqual({
      group: 'csp-endpoint',
      max_age: 10886400,
      endpoints: [{ url: reportUri }],
      include_subdomains: true,
    });
  });

  it('omits Sentry security policy reporting when DSN is missing', () => {
    expect(getSentrySecurityReportUri({})).toBeNull();
    expect(getSecurityPolicyReportingHeaders({})).toEqual({});
    expect(buildContentSecurityPolicy({ env: {} })).not.toContain('report-uri');
  });

  it('supports enforcement, report-only, and off modes', () => {
    expect(getContentSecurityPolicyMode({})).toBe('report-only');
    expect(getContentSecurityPolicyHeaderName('report-only')).toBe(
      'Content-Security-Policy-Report-Only'
    );
    expect(getContentSecurityPolicyMode({ CSP_MODE: 'enforce' })).toBe('enforce');
    expect(getContentSecurityPolicyHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(getContentSecurityPolicyMode({ CSP_MODE: 'report-only' })).toBe('report-only');
    expect(getContentSecurityPolicyMode({ CSP_MODE: 'off' })).toBe('off');
    expect(getContentSecurityPolicyHeaderName('off')).toBeNull();
    expect(getContentSecurityPolicyMode({ CSP_MODE: 'unexpected' })).toBe('report-only');
  });
});
