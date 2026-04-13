import {
  buildContentSecurityPolicy,
  getConfiguredConnectSrcOrigins,
} from '@/lib/security-headers';

describe('security headers', () => {
  it('builds CSP with nonce and required third-party sources', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'test-nonce',
      connectSrcUrls: ['wss://cloud-agent.example.com/socket'],
    });

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce'");
    expect(policy).toContain('https://js.stripe.com');
    expect(policy).toContain('https://*.js.stripe.com');
    expect(policy).toContain('https://api.stripe.com');
    expect(policy).toContain('https://hooks.stripe.com');
    expect(policy).toContain('https://login.kilo.ai');
    expect(policy).toContain('https://login-test.kilo.ai');
    expect(policy).toContain('https://www.googletagmanager.com');
    expect(policy).toContain('https://utt.impactcdn.com');
    expect(policy).toContain('https://challenges.cloudflare.com');
    expect(policy).toContain('https://cdn.jsdelivr.net');
    expect(policy).toContain('https://unpkg.com');
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).toContain('wss://cloud-agent.example.com');
  });

  it('adds development-only sources only in development mode', () => {
    const productionPolicy = buildContentSecurityPolicy({ nonce: 'n', isDevelopment: false });
    const developmentPolicy = buildContentSecurityPolicy({ nonce: 'n', isDevelopment: true });

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
    };

    expect(getConfiguredConnectSrcOrigins(env)).toEqual([
      'wss://agent.example.com',
      'wss://next-agent.example.com',
      'wss://ingest.example.com',
      'https://gastown.example.com',
    ]);
  });
});
