import { describe, expect, it } from 'vitest';
import {
  STS_BOUNCER_DECIDE,
  STS_BOUNCER_SIGNUP_DECIDE,
  STS_BOUNCER_SIGNUP_HISTORY,
  STS_BOUNCER_USAGE_WRITE,
  STS_CODE_REVIEW_CANCEL,
  STS_CODE_REVIEW_DISPATCH,
  STS_CODE_REVIEW_RETRY_FRESH,
  STS_CODE_REVIEW_STATUS_READ,
  STS_RESERVED_SCOPES,
  STS_SCOPE_REGISTRY,
  STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC,
  STS_O11Y_ALERTING_READ,
  STS_O11Y_ALERTING_WRITE,
  STS_O11Y_API_METRICS_WRITE,
  STS_SECURE_PROXY_FORWARD,
  STS_SECURITY_AUTO_ANALYSIS_ANALYSIS_CALLBACK,
  STS_SECURITY_AUTO_ANALYSIS_REMEDIATION_CALLBACK,
  STS_SECURITY_SYNC_DISMISS_FINDING,
  STS_SECURITY_SYNC_MANUAL_SYNC,
  STS_SESSION_INGEST_SESSION_ACCESS_INVALIDATE,
  STS_USAGE_PUBLISH,
  STS_USAGE_RECORD,
  STS_WEBHOOK_AGENT_INGEST_EXECUTION_CALLBACK,
  STS_WEB_AUTO_ROUTING_POOL_PINS_WRITE,
  STS_WEB_AUTO_ROUTING_PRODUCTION_PROFILE_READ,
  STS_WEB_BOT_SESSION_CALLBACK,
  STS_WEB_BYOC_CREDENTIALS_READ,
  STS_WEB_BYOC_CREDENTIALS_WRITE,
  STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ,
  STS_WEB_CODE_REVIEW_AGENT_CALLBACK,
  STS_WEB_CODE_REVIEW_STATUS_CALLBACK,
  STS_WEB_COMPUTE_BALANCE_ALERT,
  STS_WEB_GLANCEABLE_SNAPSHOT_READ,
  STS_WEB_HOSTED_WORKSPACE_PULL_REQUESTS_REFRESH,
  STS_WEB_SCIM_SYNC,
  STS_WEB_SECURITY_ANALYSIS_CALLBACK,
  STS_WEB_SECURITY_REMEDIATION_CALLBACK,
  STS_WEB_MCP_CATALOG_TOKEN_MINT,
  STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH,
  STS_WEB_SECURITY_NOTIFICATIONS_LIFECYCLE,
  STS_WEB_USAGE_RECEIPTS_READ,
  STS_WEB_USAGE_RECORD_BENCHMARK_GRADER,
  STS_WEB_USAGE_RECORD_CLASSIFIER,
  STS_WEB_USAGE_RECORD_REGION_HANDOFF,
  STS_WEB_USER_DATA_EXPORT_READY,
  isRegisteredStsScope,
  stsScopeRegistryProblems,
  type StsScopeRegistry,
} from './scopes';
import {
  AccessTokenClaimsSchema,
  AccessTokenHeaderSchema,
  Ed25519PublicJwkSchema,
  MAX_AUDIENCES_PER_MINT,
  MintRequestSchema,
  MintResultSchema,
  STS_ISSUERS,
  ScopeSchema,
  ServiceTokenClaimsSchema,
  mintResultHttpStatus,
  scopeAudience,
} from './token';

const NOW = 1_800_000_000;

function serviceClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: STS_ISSUERS.production,
    exp: NOW + 300,
    aud: 'session-ingest',
    sub: 'service:cloud-agent-next',
    client_id: 'cloud-agent-next',
    iat: NOW,
    jti: 'jti-1',
    scope: 'session-ingest:events.write',
    req: 'cloud-agent-next',
    env: 'production',
    ...overrides,
  };
}

function audiences(count: number): Array<{ audience: string; scope: string }> {
  return Array.from({ length: count }, (_, i) => ({
    audience: `svc-${i}`,
    scope: `svc-${i}:read`,
  }));
}

describe('access token header', () => {
  it.each([
    ['EdDSA with kid and at+jwt', { alg: 'EdDSA', typ: 'at+jwt', kid: 'k1' }, true],
    ['extra header parameters', { alg: 'EdDSA', typ: 'at+jwt', kid: 'k1', cty: 'x' }, true],
    ['alg none', { alg: 'none', typ: 'at+jwt', kid: 'k1' }, false],
    ['alg HS256', { alg: 'HS256', typ: 'at+jwt', kid: 'k1' }, false],
    ['typ JWT', { alg: 'EdDSA', typ: 'JWT', kid: 'k1' }, false],
    ['missing kid', { alg: 'EdDSA', typ: 'at+jwt' }, false],
    ['empty kid', { alg: 'EdDSA', typ: 'at+jwt', kid: '' }, false],
  ])('%s', (_name, header, accepted) => {
    expect(AccessTokenHeaderSchema.safeParse(header).success).toBe(accepted);
  });
});

describe('access token claims', () => {
  it.each([
    ['the service profile', serviceClaims(), true],
    ['unknown claims', serviceClaims({ cnf: { jkt: 'x' }, extra: 1 }), true],
    [
      'a user token with org, sid, act, amr',
      serviceClaims({
        sub: 'user-1',
        client_id: 'kilo-cli',
        org: 'org-1',
        sid: 'grant-1',
        act: { sub: 'service:a', act: { sub: 'service:b' } },
        auth_time: NOW - 10,
        amr: ['passkey'],
      }),
      true,
    ],
    ['an array aud, even naming the service', serviceClaims({ aud: ['session-ingest'] }), false],
    [
      'two scopes in one string',
      serviceClaims({ scope: 'session-ingest:a session-ingest:b' }),
      false,
    ],
    ['a scope array', serviceClaims({ scope: ['session-ingest:a'] }), false],
    ['a string exp', serviceClaims({ exp: String(NOW + 300) }), false],
    ['missing sub', serviceClaims({ sub: undefined }), false],
    ['missing jti', serviceClaims({ jti: undefined }), false],
    ['missing client_id', serviceClaims({ client_id: undefined }), false],
    ['missing env', serviceClaims({ env: undefined }), false],
    ['an unknown env', serviceClaims({ env: 'preview' }), false],
    ['an actor without sub', serviceClaims({ act: { client_id: 'x' } }), false],
    ['amr not an array', serviceClaims({ amr: 'passkey' }), false],
  ])('%s', (_name, claims, accepted) => {
    expect(AccessTokenClaimsSchema.safeParse(claims).success).toBe(accepted);
  });

  it('keeps unknown claims in the parsed value', () => {
    const parsed = AccessTokenClaimsSchema.parse(serviceClaims({ extra: 'kept' }));
    expect(parsed.extra).toBe('kept');
  });
});

describe('STS service-token profile', () => {
  it.each([
    ['sub service:<workload>, client_id and req the workload', serviceClaims(), true],
    ['a 300 s lifetime', serviceClaims({ exp: NOW + 300 }), true],
    ['a 301 s lifetime', serviceClaims({ exp: NOW + 301 }), false],
    ['exp not after iat', serviceClaims({ exp: NOW }), false],
    ['sub naming another workload', serviceClaims({ sub: 'service:other' }), false],
    ['a user sub', serviceClaims({ sub: 'user-1' }), false],
    ['req naming another workload', serviceClaims({ req: 'other' }), false],
    ['missing req', serviceClaims({ req: undefined }), false],
    ['an org claim', serviceClaims({ org: 'org-1' }), false],
    ['a sid claim', serviceClaims({ sid: 'grant-1' }), false],
    ['an act claim', serviceClaims({ act: { sub: 'service:a' } }), false],
    ['an auth_time claim', serviceClaims({ auth_time: NOW }), false],
    ['an amr claim', serviceClaims({ amr: ['passkey'] }), false],
    [
      'a client_id that is not a workload name',
      serviceClaims({
        client_id: 'Bad_Name',
        sub: 'service:Bad_Name',
        req: 'Bad_Name',
      }),
      false,
    ],
  ])('%s', (_name, claims, accepted) => {
    expect(ServiceTokenClaimsSchema.safeParse(claims).success).toBe(accepted);
  });
});

describe('scope strings', () => {
  it.each([
    ['gateway:models.read', true],
    ['session-ingest:events_write', true],
    ['a-b:c.d-e_f', true],
    ['gateway', false],
    ['gateway:', false],
    [':read', false],
    ['Gateway:read', false],
    ['gateway:read write', false],
    ['gateway:read:more', false],
  ])('%s', (scope, accepted) => {
    expect(ScopeSchema.safeParse(scope).success).toBe(accepted);
  });

  it('names the audience before the colon', () => {
    expect(scopeAudience('gateway:models.read')).toBe('gateway');
  });
});

describe('STS scope registry', () => {
  it('lists only the pilot scopes, the reserved probe, the UTS scopes, the phase 4 service scopes, the Bouncer scopes, the CI scopes and the phase 2 C1 scopes, so every other scope is denied', () => {
    expect(STS_SCOPE_REGISTRY).toEqual({
      web: {
        scopes: [
          'web:sts.canary',
          'web:usage.record',
          'web:security-notifications.dispatch',
          'web:security-notifications.lifecycle',
          'web:compute-balance-alert.send',
          'web:scim.sync',
          'web:user-data-exports.ready',
          'web:auto-routing.pool-pins.write',
          'web:usage.receipts.read',
          'web:auto-routing.production-profile.read',
          'web:usage.benchmark-grader.record',
          'web:usage.classifier.record',
          'web:usage.region-handoff.record',
          'web:claude-billing.payer-state.read',
          'web:glanceable-snapshot.read',
          'web:byoc-credentials.read',
          'web:byoc-credentials.write',
          'web:hosted-workspace-pull-requests.refresh',
          'web:bot-session.callback',
          'web:security-analysis.callback',
          'web:security-remediation.callback',
          'web:code-review.agent-callback',
          'web:code-review.status-callback',
          'web:mcp-catalog-token.mint',
        ],
      },
      'usage-ingest': { scopes: ['usage-ingest:sts.canary', 'usage-ingest:usage.publish'] },
      canary: { scopes: ['canary:denied-probe'] },
      'uts-feed': { scopes: ['uts-feed:revocation.read'] },
      uts: {
        scopes: [
          'uts:subjects.revoke',
          'uts:browser-sessions.end',
          'uts:api-credentials.revoke',
          'uts:token-exchange',
        ],
      },
      'ai-gateway-secure-proxy': { scopes: ['ai-gateway-secure-proxy:request.forward'] },
      o11y: { scopes: ['o11y:api-metrics.write', 'o11y:alerting.read', 'o11y:alerting.write'] },
      'security-sync': {
        scopes: ['security-sync:manual-sync.enqueue', 'security-sync:dismiss-finding.enqueue'],
      },
      bouncer: {
        scopes: [
          'bouncer:decide',
          'bouncer:usage.write',
          'bouncer:signup.decide',
          'bouncer:signup.history',
        ],
      },
      'webhook-agent-ingest': { scopes: ['webhook-agent-ingest:execution.callback'] },
      'security-auto-analysis': {
        scopes: [
          'security-auto-analysis:analysis.callback',
          'security-auto-analysis:remediation.callback',
        ],
      },
      'code-review': {
        scopes: [
          'code-review:review.dispatch',
          'code-review:review.status-read',
          'code-review:review.cancel',
          'code-review:review.retry-fresh',
        ],
      },
      'session-ingest': { scopes: ['session-ingest:session-access.invalidate'] },
      'community-contributions-dashboard': {
        scopes: ['community-contributions-dashboard:opencode.sync'],
      },
    });
    expect(STS_RESERVED_SCOPES).toEqual(['canary:denied-probe']);
    expect(isRegisteredStsScope('web', 'web:sts.canary')).toBe(true);
    expect(isRegisteredStsScope('canary', 'canary:denied-probe')).toBe(true);
    expect(isRegisteredStsScope('gateway', 'gateway:models.read')).toBe(false);
    expect(isRegisteredStsScope('web', 'usage-ingest:sts.canary')).toBe(false);
    expect(isRegisteredStsScope('uts', 'uts-feed:revocation.read')).toBe(false);
    expect(isRegisteredStsScope('web', 'usage-ingest:usage.publish')).toBe(false);
    expect(isRegisteredStsScope('usage-ingest', 'web:usage.record')).toBe(false);
    expect(isRegisteredStsScope('web', 'security-sync:manual-sync.enqueue')).toBe(false);
    expect(isRegisteredStsScope('security-sync', 'web:security-notifications.dispatch')).toBe(
      false
    );
    expect(isRegisteredStsScope('bouncer', 'bouncer:admin')).toBe(false);
    expect(isRegisteredStsScope('web', 'bouncer:decide')).toBe(false);
    expect(isRegisteredStsScope('web', 'code-review:review.dispatch')).toBe(false);
    expect(isRegisteredStsScope('code-review', 'web:code-review.status-callback')).toBe(false);
    // UTS's user scopes under the session-ingest audience are not STS scopes.
    expect(isRegisteredStsScope('session-ingest', 'session-ingest:sessions.read')).toBe(false);
    expect(isRegisteredStsScope('web', 'community-contributions-dashboard:opencode.sync')).toBe(
      false
    );
    expect(
      isRegisteredStsScope('community-contributions-dashboard', 'web:mcp-catalog-token.mint')
    ).toBe(false);
  });

  it('lists each shipped scope under its own audience', () => {
    expect(stsScopeRegistryProblems(STS_SCOPE_REGISTRY)).toEqual([]);
  });

  it.each([
    [
      'ai-gateway-secure-proxy:request.forward',
      'ai-gateway-secure-proxy',
      STS_SECURE_PROXY_FORWARD,
    ],
    ['usage-ingest:usage.publish', 'usage-ingest', STS_USAGE_PUBLISH],
    ['web:usage.record', 'web', STS_USAGE_RECORD],
    ['o11y:api-metrics.write', 'o11y', STS_O11Y_API_METRICS_WRITE],
    ['o11y:alerting.read', 'o11y', STS_O11Y_ALERTING_READ],
    ['o11y:alerting.write', 'o11y', STS_O11Y_ALERTING_WRITE],
    ['security-sync:manual-sync.enqueue', 'security-sync', STS_SECURITY_SYNC_MANUAL_SYNC],
    ['security-sync:dismiss-finding.enqueue', 'security-sync', STS_SECURITY_SYNC_DISMISS_FINDING],
    ['web:security-notifications.dispatch', 'web', STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH],
    ['bouncer:decide', 'bouncer', STS_BOUNCER_DECIDE],
    ['bouncer:usage.write', 'bouncer', STS_BOUNCER_USAGE_WRITE],
    ['bouncer:signup.decide', 'bouncer', STS_BOUNCER_SIGNUP_DECIDE],
    ['bouncer:signup.history', 'bouncer', STS_BOUNCER_SIGNUP_HISTORY],
    ['web:security-notifications.lifecycle', 'web', STS_WEB_SECURITY_NOTIFICATIONS_LIFECYCLE],
    ['web:compute-balance-alert.send', 'web', STS_WEB_COMPUTE_BALANCE_ALERT],
    ['web:scim.sync', 'web', STS_WEB_SCIM_SYNC],
    ['web:user-data-exports.ready', 'web', STS_WEB_USER_DATA_EXPORT_READY],
    ['web:auto-routing.pool-pins.write', 'web', STS_WEB_AUTO_ROUTING_POOL_PINS_WRITE],
    ['web:usage.receipts.read', 'web', STS_WEB_USAGE_RECEIPTS_READ],
    [
      'web:auto-routing.production-profile.read',
      'web',
      STS_WEB_AUTO_ROUTING_PRODUCTION_PROFILE_READ,
    ],
    ['web:usage.benchmark-grader.record', 'web', STS_WEB_USAGE_RECORD_BENCHMARK_GRADER],
    ['web:usage.classifier.record', 'web', STS_WEB_USAGE_RECORD_CLASSIFIER],
    ['web:usage.region-handoff.record', 'web', STS_WEB_USAGE_RECORD_REGION_HANDOFF],
    ['web:claude-billing.payer-state.read', 'web', STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ],
    ['web:glanceable-snapshot.read', 'web', STS_WEB_GLANCEABLE_SNAPSHOT_READ],
    ['web:byoc-credentials.read', 'web', STS_WEB_BYOC_CREDENTIALS_READ],
    ['web:byoc-credentials.write', 'web', STS_WEB_BYOC_CREDENTIALS_WRITE],
    [
      'web:hosted-workspace-pull-requests.refresh',
      'web',
      STS_WEB_HOSTED_WORKSPACE_PULL_REQUESTS_REFRESH,
    ],
    ['web:bot-session.callback', 'web', STS_WEB_BOT_SESSION_CALLBACK],
    ['web:security-analysis.callback', 'web', STS_WEB_SECURITY_ANALYSIS_CALLBACK],
    ['web:security-remediation.callback', 'web', STS_WEB_SECURITY_REMEDIATION_CALLBACK],
    ['web:code-review.agent-callback', 'web', STS_WEB_CODE_REVIEW_AGENT_CALLBACK],
    ['web:code-review.status-callback', 'web', STS_WEB_CODE_REVIEW_STATUS_CALLBACK],
    [
      'webhook-agent-ingest:execution.callback',
      'webhook-agent-ingest',
      STS_WEBHOOK_AGENT_INGEST_EXECUTION_CALLBACK,
    ],
    [
      'security-auto-analysis:analysis.callback',
      'security-auto-analysis',
      STS_SECURITY_AUTO_ANALYSIS_ANALYSIS_CALLBACK,
    ],
    [
      'security-auto-analysis:remediation.callback',
      'security-auto-analysis',
      STS_SECURITY_AUTO_ANALYSIS_REMEDIATION_CALLBACK,
    ],
    ['code-review:review.dispatch', 'code-review', STS_CODE_REVIEW_DISPATCH],
    ['code-review:review.status-read', 'code-review', STS_CODE_REVIEW_STATUS_READ],
    ['code-review:review.cancel', 'code-review', STS_CODE_REVIEW_CANCEL],
    ['code-review:review.retry-fresh', 'code-review', STS_CODE_REVIEW_RETRY_FRESH],
    [
      'session-ingest:session-access.invalidate',
      'session-ingest',
      STS_SESSION_INGEST_SESSION_ACCESS_INVALIDATE,
    ],
    ['web:mcp-catalog-token.mint', 'web', STS_WEB_MCP_CATALOG_TOKEN_MINT],
    [
      'community-contributions-dashboard:opencode.sync',
      'community-contributions-dashboard',
      STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC,
    ],
  ])('registers %s under its own audience %s', (scope, audience, pair) => {
    expect(pair).toEqual({ audience, scope });
    expect(scopeAudience(pair.scope)).toBe(pair.audience);
    expect(isRegisteredStsScope(pair.audience, pair.scope)).toBe(true);
  });

  it('flags a scope whose prefix is not its audience', () => {
    const registry: StsScopeRegistry = { gateway: { scopes: ['o11y:write', 'gateway:read'] } };
    expect(stsScopeRegistryProblems(registry)).toEqual([
      'gateway: scope o11y:write belongs to audience o11y',
    ]);
  });

  it('flags invalid audiences, invalid scopes and duplicates', () => {
    const registry: StsScopeRegistry = {
      Gateway: { scopes: [] },
      o11y: { scopes: ['o11y:write', 'o11y:write', 'o11y'] },
    };
    expect(stsScopeRegistryProblems(registry)).toEqual([
      'audience "Gateway" is not a valid audience',
      'o11y: scope o11y:write is listed twice',
      'o11y: scope "o11y" is not a valid scope',
    ]);
  });

  it('never matches an inherited object key', () => {
    const registry: StsScopeRegistry = { o11y: { scopes: ['o11y:write'] } };
    expect(isRegisteredStsScope('o11y', 'o11y:write', registry)).toBe(true);
    expect(isRegisteredStsScope('constructor', 'constructor:x', registry)).toBe(false);
    expect(isRegisteredStsScope('__proto__', '__proto__:x', registry)).toBe(false);
  });
});

describe('mint request', () => {
  it.each([
    ['one token', { tokens: audiences(1) }, true],
    [`${MAX_AUDIENCES_PER_MINT} audiences`, { tokens: audiences(MAX_AUDIENCES_PER_MINT) }, true],
    ['no tokens', { tokens: [] }, false],
    ['9 audiences', { tokens: audiences(9) }, false],
    [
      'a duplicate audience',
      {
        tokens: [
          { audience: 'o11y', scope: 'o11y:read' },
          { audience: 'o11y', scope: 'o11y:write' },
        ],
      },
      false,
    ],
    [
      'a scope of another audience',
      { tokens: [{ audience: 'o11y', scope: 'gateway:read' }] },
      false,
    ],
    [
      'two scopes for one audience',
      { tokens: [{ audience: 'o11y', scope: 'o11y:read o11y:write' }] },
      false,
    ],
    ['an extra field', { tokens: audiences(1), lifetime: 600 }, false],
  ])('%s', (_name, request, accepted) => {
    expect(MintRequestSchema.safeParse(request).success).toBe(accepted);
  });
});

describe('mint result', () => {
  const issued = {
    status: 'issued',
    audience: 'o11y',
    scope: 'o11y:write',
    token: 'header.payload.signature',
    jti: 'jti-1',
    expiresAt: NOW + 300,
  };

  it.each([
    [
      'issued and denied entries',
      {
        status: 'ok',
        tokens: [
          issued,
          { status: 'denied', audience: 'gateway', scope: 'gateway:read', reason: 'unknown_scope' },
        ],
      },
      true,
    ],
    [
      'a denial with an unknown reason',
      {
        status: 'ok',
        tokens: [{ status: 'denied', audience: 'gateway', scope: 'gateway:read', reason: 'nope' }],
      },
      false,
    ],
    ['two results for one audience', { status: 'ok', tokens: [issued, issued] }, false],
    ['unavailable with retry seconds', { status: 'unavailable', retryAfterSeconds: 5 }, true],
    ['unavailable without retry seconds', { status: 'unavailable' }, false],
    ['identity rejected', { status: 'identity_rejected' }, true],
    ['invalid request', { status: 'invalid_request' }, true],
  ])('%s', (_name, result, accepted) => {
    expect(MintResultSchema.safeParse(result).success).toBe(accepted);
  });

  it('maps each whole-request outcome to its HTTP status', () => {
    expect(mintResultHttpStatus(MintResultSchema.parse({ status: 'ok', tokens: [issued] }))).toBe(
      200
    );
    expect(mintResultHttpStatus({ status: 'invalid_request' })).toBe(400);
    expect(mintResultHttpStatus({ status: 'identity_rejected' })).toBe(401);
    expect(mintResultHttpStatus({ status: 'unavailable', retryAfterSeconds: 1 })).toBe(503);
  });
});

describe('signing keys', () => {
  const x = 'A'.repeat(43);
  it.each([
    ['an Ed25519 key', { kty: 'OKP', crv: 'Ed25519', x, kid: 'k1' }, true],
    [
      'with alg EdDSA and use sig',
      { kty: 'OKP', crv: 'Ed25519', x, kid: 'k1', alg: 'EdDSA', use: 'sig' },
      true,
    ],
    ['an X25519 key', { kty: 'OKP', crv: 'X25519', x, kid: 'k1' }, false],
    ['an EC key', { kty: 'EC', crv: 'P-256', x, y: x, kid: 'k1' }, false],
    ['missing kid', { kty: 'OKP', crv: 'Ed25519', x }, false],
    ['a short x', { kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'k1' }, false],
    ['use enc', { kty: 'OKP', crv: 'Ed25519', x, kid: 'k1', use: 'enc' }, false],
  ])('%s', (_name, jwk, accepted) => {
    expect(Ed25519PublicJwkSchema.safeParse(jwk).success).toBe(accepted);
  });
});

describe('issuers', () => {
  it('match STS_ISSUER of each wrangler environment', () => {
    expect(STS_ISSUERS).toEqual({
      development: 'http://localhost:8825',
      staging: 'https://sts-staging.kiloapps.io',
      production: 'https://sts.kiloapps.io',
    });
  });
});
