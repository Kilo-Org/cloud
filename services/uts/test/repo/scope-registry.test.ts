import {
  KILO_API_MCP_READ_SCOPE,
  KILO_API_PROFILE_READ_SCOPE,
  KILO_GATEWAY_INFERENCE_SCOPE,
  KILO_MCP_CATALOG_READ_SCOPE,
  PAGES_DEV_TOOLS_USE_SCOPE,
  KILO_WEB_CALLBACK_PATH,
  UTS_ACCOUNT_AUDIENCE,
  UTS_BOT_KEYS_MANAGE_SCOPE,
  UTS_BROWSER_SESSION_READ_SCOPE,
  UTS_CREDENTIAL_SCOPES,
  UTS_FIRST_PARTY_CLIENTS,
  UTS_ORG_ROLES,
  UTS_PATS_MANAGE_SCOPE,
  UTS_PROBE_READ_SCOPE,
  UTS_SCOPE_REGISTRY,
  UTS_SECURITY_READ_SCOPE,
  type UtsFirstPartyClient,
  type UtsScopeEntry,
  firstPartyClient,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ORG_ROLES } from '../../src/db/enums';
import { identifyClient } from '../../src/oauth/clients';
import {
  DEVELOPMENT_FIXTURE_SCOPES,
  developmentScopes,
} from '../../src/scopes/development-fixtures';
import { clientScopeRefusal, credentialScopeCheck, orgScopeRefusal } from '../../src/scopes/policy';
import { importClosure } from './import-graph';
import { firstPartyClientProblems, scopeRegistryProblems } from './scope-registry';

/** The scope registry as code (design 5.3), checked against its rules. */

const base: UtsScopeEntry = {
  audience: 'gateway',
  maxLifetimeSeconds: 600,
  allowedClients: ['kilo-cli'],
  subjects: { kind: 'any_user' },
  thirdPartySafe: false,
  stepUp: false,
  patEligible: true,
  privileged: false,
  requiresSession: false,
  requiresOrgClaim: false,
  delegable: false,
  issuance: 'grant',
  delegatesTo: [],
  consentText: null,
};
/** One entry for `scope`, its audience taken from the scope unless `overrides` names another. */
const check = (scope: string, overrides: Partial<UtsScopeEntry>) =>
  scopeRegistryProblems({
    [scope]: { ...base, audience: scope.split(':')[0], ...overrides },
  });

describe('the UTS scope registry', () => {
  it('follows every rule', () => {
    expect(scopeRegistryProblems(UTS_SCOPE_REGISTRY)).toEqual([]);
  });

  it('lists the scopes the account API and the probe route need, as they need them', () => {
    for (const scope of [UTS_PATS_MANAGE_SCOPE, UTS_BOT_KEYS_MANAGE_SCOPE]) {
      expect(utsScopeEntry(scope)).toMatchObject({
        audience: UTS_ACCOUNT_AUDIENCE,
        allowedClients: ['kilo-cli', 'kilo-web'],
        patEligible: false,
        thirdPartySafe: false,
        requiresSession: true,
        requiresOrgClaim: false,
      });
    }
    expect(utsScopeEntry(UTS_PROBE_READ_SCOPE)).toMatchObject({
      audience: UTS_ACCOUNT_AUDIENCE,
      allowedClients: ['kilo-cli'],
      patEligible: true,
      requiresSession: false,
    });
  });

  it('lets the CLI and the web BFF hold the credential-manage scopes, and no other client', () => {
    for (const scope of [UTS_PATS_MANAGE_SCOPE, UTS_BOT_KEYS_MANAGE_SCOPE]) {
      for (const client of [
        { kind: 'first_party', clientId: 'kilo-cli' },
        { kind: 'confidential_web', clientId: 'kilo-web' },
      ] as const) {
        expect(clientScopeRefusal([scope], client, utsScopeEntry)).toBeNull();
      }
      for (const client of [
        { kind: 'first_party', clientId: 'kilo-mobile' },
        { kind: 'third_party', clientId: 'https://client.example.com/oauth/client.json' },
      ] as const) {
        expect(clientScopeRefusal([scope], client, utsScopeEntry)).toBe(scope);
      }
    }
    expect(
      clientScopeRefusal(
        [UTS_PROBE_READ_SCOPE],
        { kind: 'confidential_web', clientId: 'kilo-web' },
        utsScopeEntry
      )
    ).toBe(UTS_PROBE_READ_SCOPE);
  });

  it('lists the Kilo API profile scope for the CLI and for PATs, and a PAT may carry it', () => {
    const entry = utsScopeEntry(KILO_API_PROFILE_READ_SCOPE);
    expect(entry).toEqual({
      audience: 'kilo-api',
      maxLifetimeSeconds: 600,
      allowedClients: ['kilo-cli'],
      subjects: { kind: 'any_user' },
      thirdPartySafe: false,
      stepUp: false,
      patEligible: true,
      privileged: false,
      requiresSession: false,
      requiresOrgClaim: false,
      delegable: false,
      issuance: 'grant',
      delegatesTo: [],
      consentText: null,
    });
    expect(scopeRegistryProblems({ [KILO_API_PROFILE_READ_SCOPE]: entry ?? base })).toEqual([]);
    expect(credentialScopeCheck(KILO_API_PROFILE_READ_SCOPE, null)).toEqual({ status: 'allowed' });
  });

  it('lists the one AI gateway scope for the CLI and the mobile app, 10 minutes, PAT-eligible', () => {
    expect(KILO_GATEWAY_INFERENCE_SCOPE).toBe('kilo-gateway:inference');
    const entry = utsScopeEntry(KILO_GATEWAY_INFERENCE_SCOPE);
    expect(entry).toEqual({
      audience: 'kilo-gateway',
      maxLifetimeSeconds: 600,
      allowedClients: ['kilo-cli', 'kilo-mobile'],
      subjects: { kind: 'any_user' },
      thirdPartySafe: false,
      stepUp: false,
      patEligible: true,
      privileged: false,
      requiresSession: false,
      requiresOrgClaim: false,
      delegable: false,
      issuance: 'grant',
      delegatesTo: [],
      consentText: null,
    });
    expect(
      Object.entries(UTS_SCOPE_REGISTRY)
        .filter(([, scopeEntry]) => scopeEntry.audience === 'kilo-gateway')
        .map(([scope]) => scope)
    ).toEqual([KILO_GATEWAY_INFERENCE_SCOPE]);
    for (const clientId of ['kilo-cli', 'kilo-mobile']) {
      expect(
        clientScopeRefusal(
          [KILO_GATEWAY_INFERENCE_SCOPE],
          { kind: 'first_party', clientId },
          utsScopeEntry
        )
      ).toBeNull();
    }
    for (const client of [
      { kind: 'first_party', clientId: 'kilo-web' },
      { kind: 'third_party', clientId: 'https://client.example.com/oauth/client.json' },
    ] as const) {
      expect(clientScopeRefusal([KILO_GATEWAY_INFERENCE_SCOPE], client, utsScopeEntry)).toBe(
        KILO_GATEWAY_INFERENCE_SCOPE
      );
    }
    // No organization is needed or added: a personal grant and an org-bound one both mint it, and
    // a PAT or an org bot key may carry it.
    expect(orgScopeRefusal([KILO_GATEWAY_INFERENCE_SCOPE], null, null, utsScopeEntry)).toBeNull();
    expect(credentialScopeCheck(KILO_GATEWAY_INFERENCE_SCOPE, null)).toEqual({ status: 'allowed' });
    expect(credentialScopeCheck(KILO_GATEWAY_INFERENCE_SCOPE, 'org-1')).toEqual({
      status: 'allowed',
    });
  });

  it('knows no scope it does not list, including object property names', () => {
    for (const scope of ['gateway:unknown.read', 'toString', '__proto__', 'constructor']) {
      expect(utsScopeEntry(scope)).toBeNull();
    }
  });

  it.each([UTS_SECURITY_READ_SCOPE, UTS_BROWSER_SESSION_READ_SCOPE])(
    'lists %s for the web app only, with a session, 10 minutes, and no PAT carries it',
    scope => {
      expect(utsScopeEntry(scope)).toEqual({
        audience: UTS_ACCOUNT_AUDIENCE,
        maxLifetimeSeconds: 600,
        allowedClients: ['kilo-web'],
        subjects: { kind: 'any_user' },
        thirdPartySafe: false,
        stepUp: false,
        patEligible: false,
        privileged: false,
        requiresSession: true,
        requiresOrgClaim: false,
        delegable: false,
        issuance: 'grant',
        delegatesTo: [],
        consentText: null,
      });
      expect(credentialScopeCheck(scope, null)).toEqual({ status: 'not_pat_eligible' });
      expect(UTS_CREDENTIAL_SCOPES).not.toContain(scope);
    }
  );

  it('names the browser-session bootstrap scope exactly', () => {
    expect(UTS_BROWSER_SESSION_READ_SCOPE).toBe('uts:browser-session.read');
  });

  it.each([
    ['session-ingest:sessions.read', ['kilo-cli', 'kilo-web'], true, 600, false],
    ['session-ingest:sessions.write', ['kilo-cli', 'kilo-web'], true, 600, false],
    ['session-ingest:live.connect', ['kilo-cli', 'kilo-web'], true, 600, false],
    ['session-ingest:sessions.share', ['kilo-web'], true, 600, false],
    ['cloud-agent-next:sessions.read', ['kilo-web'], true, 600, false],
    ['user-data-export:exports.dispatch', ['kilo-web'], true, 300, false],
    ['user-data-export:exports.download', ['kilo-web'], true, 300, false],
    ['git-token-service:github-user-authorizations.disconnect', ['kilo-web'], true, 300, false],
    ['git-token-service:bitbucket.repositories.read', ['kilo-web'], true, 600, true],
  ] as const)(
    'lists %s for %j, session %s, %i seconds, org claim %s, and no PAT carries it',
    (scope, clients, requiresSession, lifetime, orgClaim) => {
      expect(utsScopeEntry(scope)).toEqual({
        audience: scope.split(':')[0],
        maxLifetimeSeconds: lifetime,
        allowedClients: clients,
        subjects: orgClaim ? { kind: 'org_member', roles: 'any' } : { kind: 'any_user' },
        thirdPartySafe: false,
        stepUp: false,
        patEligible: false,
        privileged: false,
        requiresSession,
        requiresOrgClaim: orgClaim,
        delegable: false,
        issuance: 'grant',
        delegatesTo: [],
        consentText: null,
      });
      expect(credentialScopeCheck(scope, null)).toEqual({ status: 'not_pat_eligible' });
    }
  );

  it.each([
    ['ai-attribution:identity.read', ['kilo-cli'], ['owner', 'member']],
    ['ai-attribution:attributions.write', ['kilo-cli'], ['owner', 'member']],
    ['session-sync:grants.exchange', ['kilo-cli', 'kilo-mobile'], null],
    ['notifications:badges.read', ['kilo-mobile'], null],
    ['notifications:badges.write', ['kilo-mobile'], null],
    ['event-service:events.subscribe', ['kilo-web', 'kilo-mobile', 'kilo-cli'], null],
    ['kilo-chat:chat.use', ['kilo-web'], null],
    ['kilo-api:home-widget.use', ['kilo-mobile'], null],
  ] as const)(
    'lists %s for %j with a session for 10 minutes, org roles %j, no PAT and no delegation',
    (scope, clients, roles) => {
      expect(utsScopeEntry(scope)).toEqual({
        audience: scope.split(':')[0],
        maxLifetimeSeconds: 600,
        allowedClients: clients,
        subjects: roles === null ? { kind: 'any_user' } : { kind: 'org_member', roles },
        thirdPartySafe: false,
        stepUp: false,
        patEligible: false,
        privileged: false,
        requiresSession: true,
        requiresOrgClaim: roles !== null,
        delegable: false,
        issuance: 'grant',
        delegatesTo: [],
        consentText: null,
      });
    }
  );

  it.each([
    ['kilo-api:notifications.read', false, false],
    ['kilo-api:organizations.read', false, false],
    ['kilo-api:auto-routing.read', false, false],
    ['kilo-api:organizations.write', true, true],
    ['kilo-api:auto-routing.write', true, false],
    ['kilo-api:sessions.write', true, false],
    ['kilo-api:shell-security.analyze', true, false],
    ['kilo-api:feedback.write', true, false],
    ['kilo-api:credits.redeem', true, false],
  ] as const)(
    'lists %s for the CLI only, session %s, org members %s, 10 minutes, and no PAT carries it',
    (scope, requiresSession, orgMembers) => {
      expect(utsScopeEntry(scope)).toEqual({
        audience: 'kilo-api',
        maxLifetimeSeconds: 600,
        allowedClients: ['kilo-cli'],
        subjects: orgMembers ? { kind: 'org_member', roles: 'any' } : { kind: 'any_user' },
        thirdPartySafe: false,
        stepUp: false,
        patEligible: false,
        privileged: false,
        requiresSession,
        requiresOrgClaim: orgMembers,
        delegable: false,
        issuance: 'grant',
        delegatesTo: [],
        consentText: null,
      });
      expect(credentialScopeCheck(scope, null)).toEqual({ status: 'not_pat_eligible' });
    }
  );

  it('lists exactly these Kilo API scopes, with no generic write scope', () => {
    expect(
      Object.keys(UTS_SCOPE_REGISTRY)
        .filter(scope => scope.startsWith('kilo-api:'))
        .sort()
    ).toEqual([
      'kilo-api:auto-routing.read',
      'kilo-api:auto-routing.write',
      'kilo-api:credits.redeem',
      'kilo-api:feedback.write',
      'kilo-api:home-widget.use',
      'kilo-api:mcp.read',
      'kilo-api:notifications.read',
      'kilo-api:organizations.read',
      'kilo-api:organizations.write',
      'kilo-api:profile.read',
      'kilo-api:sessions.write',
      'kilo-api:shell-security.analyze',
    ]);
  });

  it('lists the Kilo MCP catalog scope for third-party clients and the CLI, delegating only the Kilo API MCP read', () => {
    expect(utsScopeEntry(KILO_MCP_CATALOG_READ_SCOPE)).toEqual({
      audience: 'kilo-mcp',
      maxLifetimeSeconds: 600,
      allowedClients: ['third_party', 'kilo-cli'],
      subjects: { kind: 'any_user' },
      thirdPartySafe: true,
      stepUp: false,
      patEligible: false,
      privileged: false,
      requiresSession: false,
      requiresOrgClaim: false,
      delegable: false,
      issuance: 'grant',
      delegatesTo: ['kilo-api:mcp.read'],
      consentText:
        "Read your Kilo tool catalog and Kilo's global preferred models and model provider names through Kilo MCP",
    });
    expect(
      Object.entries(UTS_SCOPE_REGISTRY)
        .filter(([, entry]) => entry.delegatesTo.length > 0)
        .map(([scope, entry]) => [scope, entry.delegatesTo])
    ).toEqual([[KILO_MCP_CATALOG_READ_SCOPE, [KILO_API_MCP_READ_SCOPE]]]);
    expect(credentialScopeCheck(KILO_MCP_CATALOG_READ_SCOPE, null)).toEqual({
      status: 'not_pat_eligible',
    });
  });

  it('lists the Kilo API MCP read as a 5-minute exchange scope that no grant mints', () => {
    expect(utsScopeEntry(KILO_API_MCP_READ_SCOPE)).toEqual({
      audience: 'kilo-api',
      maxLifetimeSeconds: 300,
      allowedClients: ['third_party', 'kilo-cli'],
      subjects: { kind: 'any_user' },
      thirdPartySafe: true,
      stepUp: false,
      patEligible: false,
      privileged: false,
      requiresSession: false,
      requiresOrgClaim: false,
      delegable: true,
      issuance: 'token_exchange',
      delegatesTo: [],
      consentText: null,
    });
    // `/authorize`, the token endpoint and the device grant all refuse it.
    for (const client of [
      { kind: 'first_party', clientId: 'kilo-cli' },
      { kind: 'third_party', clientId: 'https://client.example.com/oauth/client.json' },
    ] as const) {
      expect(clientScopeRefusal([KILO_API_MCP_READ_SCOPE], client, utsScopeEntry)).toBe(
        KILO_API_MCP_READ_SCOPE
      );
    }
    expect(
      clientScopeRefusal(
        [KILO_MCP_CATALOG_READ_SCOPE],
        { kind: 'third_party', clientId: 'https://client.example.com/oauth/client.json' },
        utsScopeEntry
      )
    ).toBeNull();
  });

  it('lists the pages-dev tool scope for the web app only, 5 minutes, with a session', () => {
    expect(utsScopeEntry(PAGES_DEV_TOOLS_USE_SCOPE)).toEqual({
      audience: 'pages-dev',
      maxLifetimeSeconds: 300,
      allowedClients: ['kilo-web'],
      subjects: { kind: 'any_user' },
      thirdPartySafe: false,
      stepUp: false,
      patEligible: false,
      privileged: false,
      requiresSession: true,
      requiresOrgClaim: false,
      delegable: false,
      issuance: 'grant',
      delegatesTo: [],
      consentText: null,
    });
    expect(utsScopeEntry('pages:tools.use')).toBeNull();
  });

  it('gives a consent line exactly to the scopes a third-party client can ask for', () => {
    const consentable = Object.entries(UTS_SCOPE_REGISTRY)
      .filter(([, entry]) => entry.consentText !== null)
      .map(([scope]) => scope);
    expect(consentable).toEqual([KILO_MCP_CATALOG_READ_SCOPE]);
  });

  it('names the membership roles of the identity store', () => {
    expect([...UTS_ORG_ROLES]).toEqual([...ORG_ROLES]);
  });

  it('refuses at the authorization and token endpoints every org-claim scope without an organization', () => {
    const orgScopes = Object.entries(UTS_SCOPE_REGISTRY)
      .filter(([, entry]) => entry.requiresOrgClaim)
      .map(([scope]) => scope);
    expect(orgScopes).toContain('ai-attribution:identity.read');
    for (const scope of orgScopes) {
      expect(
        orgScopeRefusal(['session-sync:grants.exchange', scope], null, null, utsScopeEntry)
      ).toBe(scope);
      expect(orgScopeRefusal([scope], crypto.randomUUID(), 'owner', utsScopeEntry)).toBeNull();
    }
    expect(orgScopeRefusal(['session-sync:grants.exchange'], null, null, utsScopeEntry)).toBe(null);
    // An unregistered scope is refused, never let through.
    expect(orgScopeRefusal(['gateway:unknown.read'], null, null, utsScopeEntry)).toBe(
      'gateway:unknown.read'
    );
  });

  it('refuses a scope limited to listed roles to every other role and to a missing role', () => {
    const org = crypto.randomUUID();
    const scope = 'ai-attribution:attributions.write';
    const refusal = (role: (typeof UTS_ORG_ROLES)[number] | null) =>
      orgScopeRefusal([scope], org, role, utsScopeEntry);
    expect(refusal('owner')).toBeNull();
    expect(refusal('member')).toBeNull();
    expect(refusal('admin')).toBe(scope);
    expect(refusal('billing_manager')).toBe(scope);
    expect(refusal(null)).toBe(scope);
    // A scope open to every role of the organization passes any role.
    for (const role of UTS_ORG_ROLES) {
      expect(
        orgScopeRefusal(['git-token-service:bitbucket.repositories.read'], org, role, utsScopeEntry)
      ).toBeNull();
    }
  });

  it('lets each client mint through a grant exactly the scopes that list it, and no exchange scope', () => {
    for (const [scope, entry] of Object.entries(UTS_SCOPE_REGISTRY)) {
      for (const client of UTS_FIRST_PARTY_CLIENTS) {
        const refused = clientScopeRefusal(
          [scope],
          { kind: 'first_party', clientId: client.clientId },
          utsScopeEntry
        );
        expect(refused).toBe(
          entry.allowedClients.includes(client.clientId) && entry.issuance === 'grant'
            ? null
            : scope
        );
      }
      expect(
        clientScopeRefusal(
          [scope],
          { kind: 'third_party', clientId: 'https://client.example.com/metadata.json' },
          utsScopeEntry
        )
      ).toBe(entry.thirdPartySafe && entry.issuance === 'grant' ? null : scope);
    }
    expect(
      clientScopeRefusal(
        ['gateway:unknown.read'],
        { kind: 'first_party', clientId: 'kilo-cli' },
        utsScopeEntry
      )
    ).toBe('gateway:unknown.read');
  });
});

describe('first-party clients', () => {
  it('follow every rule', () => {
    expect(firstPartyClientProblems(UTS_FIRST_PARTY_CLIENTS)).toEqual([]);
  });

  it('register the web app as a confidential client with its exact BFF callbacks', () => {
    expect(firstPartyClient('kilo-web')).toEqual({
      kind: 'confidential_web',
      clientId: 'kilo-web',
      name: 'Kilo web app',
      tokenEndpointAuthMethod: 'private_key_jwt',
      redirectUris: {
        production: [`https://app.kilo.ai${KILO_WEB_CALLBACK_PATH}`],
        staging: [`https://staging-app.kilo.ai${KILO_WEB_CALLBACK_PATH}`],
        development: [`http://localhost:3000${KILO_WEB_CALLBACK_PATH}`],
      },
    });
    expect(KILO_WEB_CALLBACK_PATH).toBe('/api/auth/uts/callback');
    expect(firstPartyClient('kilo-cli')).toMatchObject({ kind: 'public_native' });
  });

  it('register the mobile app with its private-use redirect and the attestation it needs', () => {
    expect(firstPartyClient('kilo-mobile')).toEqual({
      kind: 'public_native',
      clientId: 'kilo-mobile',
      name: 'Kilo mobile app',
      clientClass: 'mobile',
      redirect: { kind: 'private_use_scheme', uri: 'com.kilocode.kiloapp:/oauth/callback' },
      attestation: 'required',
    });
  });

  it('keep the confidential client off the OAuth endpoints until they check its private-key JWT', () => {
    expect(identifyClient('kilo-web')).toEqual({ kind: 'unknown' });
    expect(identifyClient('kilo-cli')).toMatchObject({ kind: 'first_party' });
  });

  /** A confidential web client whose redirect URIs are the valid ones below, with `uris` replaced. */
  const web = (
    uris: Partial<Record<'production' | 'staging' | 'development', readonly string[]>> = {}
  ): UtsFirstPartyClient => ({
    kind: 'confidential_web',
    clientId: 'kilo-web',
    name: 'Kilo web app',
    tokenEndpointAuthMethod: 'private_key_jwt',
    redirectUris: {
      production: ['https://app.kilo.ai/cb'],
      staging: ['https://staging-app.kilo.ai/cb'],
      development: ['http://localhost:3000/cb'],
      ...uris,
    },
  });

  it.each([
    ['plain HTTP in staging', { staging: ['http://staging-app.kilo.ai/cb'] }],
    ['a loopback origin in production', { production: ['http://localhost:3000/cb'] }],
    ['no path', { production: ['https://app.kilo.ai'] }],
    ['a query', { production: ['https://app.kilo.ai/cb?x=1'] }],
    ['a fragment', { production: ['https://app.kilo.ai/cb#x'] }],
    ['no URI at all', { staging: [] }],
  ] as const)('refuse a confidential client redirect with %s', (_name, uris) => {
    expect(firstPartyClientProblems([web()])).toEqual([]);
    expect(firstPartyClientProblems([web(uris)])).toHaveLength(1);
  });

  const native = (overrides: Partial<Extract<UtsFirstPartyClient, { kind: 'public_native' }>>) =>
    ({
      kind: 'public_native',
      clientId: 'kilo-mobile',
      name: 'Kilo mobile app',
      clientClass: 'mobile',
      redirect: { kind: 'private_use_scheme', uri: 'com.kilocode.kiloapp:/oauth/callback' },
      attestation: 'required',
      ...overrides,
    }) satisfies UtsFirstPartyClient;

  it.each([
    ['a mobile client on a loopback path', { redirect: { kind: 'loopback', path: '/callback' } }],
    [
      'a scheme that is not a reverse domain',
      { redirect: { kind: 'private_use_scheme', uri: 'kiloapp:/oauth/callback' } },
    ],
    [
      'a private-use URI with two slashes',
      { redirect: { kind: 'private_use_scheme', uri: 'com.kilocode.kiloapp://oauth/callback' } },
    ],
    ['a mobile client without attestation', { attestation: 'none' }],
    [
      'a desktop client on a private-use URI',
      { clientClass: 'desktop', attestation: 'none', clientId: 'kilo-cli' },
    ],
  ] as const)('refuse %s', (_name, overrides) => {
    expect(firstPartyClientProblems([native({})])).toEqual([]);
    expect(firstPartyClientProblems([native(overrides)])).toHaveLength(1);
  });

  it('refuse a client id registered twice', () => {
    expect(firstPartyClientProblems([web(), web()])).toContain('a client id is registered twice');
  });
});

describe('the registry check', () => {
  it.each([
    ['a malformed scope', 'Gateway', {}, 'is not <audience>:<permission>'],
    ['another audience', 'gateway:models.read', { audience: 'mcp' }, 'names another audience'],
    [
      'a lifetime over 10 minutes',
      'gateway:models.read',
      { maxLifetimeSeconds: 601 },
      'max lifetime',
    ],
    ['no client', 'gateway:models.read', { allowedClients: [] }, 'allows no client'],
    [
      'a client twice',
      'gateway:models.read',
      { allowedClients: ['kilo-cli', 'kilo-cli'] },
      'twice',
    ],
    ['an unknown client', 'gateway:models.read', { allowedClients: ['web'] }, 'allows web'],
    [
      'a third-party flag without third_party',
      'gateway:models.read',
      { thirdPartySafe: true, consentText: 'Read your models' },
      'disagree',
    ],
    [
      'a privileged PAT scope',
      'admin:users.read',
      { privileged: true, stepUp: true, maxLifetimeSeconds: 300 },
      'PAT-eligible but privileged',
    ],
    [
      'a staff scope for third parties',
      'sts:dev.read',
      {
        subjects: { kind: 'staff', list: 'sts-person-policy' },
        allowedClients: ['third_party'],
        thirdPartySafe: true,
        patEligible: false,
        consentText: 'Read development data',
      },
      'third-party-safe but',
    ],
    ['a PAT that makes PATs', UTS_PATS_MANAGE_SCOPE, { audience: 'uts' }, 'changes credentials'],
    [
      'a privileged scope without a step-up',
      'admin:users.read',
      { privileged: true, patEligible: false, maxLifetimeSeconds: 300 },
      'without a step-up',
    ],
    [
      'a privileged scope over 5 minutes',
      'admin:users.read',
      { privileged: true, stepUp: true, patEligible: false },
      'max lifetime must be 1 to 300',
    ],
    [
      'a session-bound PAT scope',
      'gateway:models.read',
      { requiresSession: true },
      'needs a session but is PAT-eligible',
    ],
    [
      'an org claim without organization-member subjects',
      'gateway:models.read',
      { requiresOrgClaim: true },
      'org claim need and organization-member subjects disagree',
    ],
    [
      'organization-member subjects without the org claim',
      'gateway:models.read',
      { subjects: { kind: 'org_member', roles: 'any' } },
      'org claim need and organization-member subjects disagree',
    ],
    [
      'no organization role',
      'gateway:models.read',
      { subjects: { kind: 'org_member', roles: [] }, requiresOrgClaim: true, patEligible: false },
      'organization roles',
    ],
    [
      'an organization role twice',
      'gateway:models.read',
      {
        subjects: { kind: 'org_member', roles: ['owner', 'owner'] },
        requiresOrgClaim: true,
        patEligible: false,
      },
      'organization roles',
    ],
    [
      'a PAT that carries a role-limited scope',
      'gateway:models.read',
      { subjects: { kind: 'org_member', roles: ['owner'] }, requiresOrgClaim: true },
      'limited to listed roles but',
    ],
    [
      'a role-limited scope for third parties',
      'mcp:tools.read',
      {
        subjects: { kind: 'org_member', roles: ['member'] },
        requiresOrgClaim: true,
        patEligible: false,
        allowedClients: ['third_party'],
        thirdPartySafe: true,
        consentText: 'Read your tools',
      },
      'limited to listed roles but',
    ],
    [
      'a delegable credential scope',
      UTS_PATS_MANAGE_SCOPE,
      { audience: 'uts', patEligible: false, delegable: true },
      'is delegable but',
    ],
    [
      'a delegable privileged scope',
      'admin:users.read',
      {
        privileged: true,
        stepUp: true,
        patEligible: false,
        maxLifetimeSeconds: 300,
        delegable: true,
      },
      'is delegable but',
    ],
    [
      'a scope that delegates to an unregistered scope',
      'kilo-mcp:catalog.read',
      { patEligible: false, delegatesTo: ['kilo-api:unknown.read'] },
      'which is not a registered exchange scope',
    ],
    [
      'a third-party scope without a consent line',
      'mcp:tools.read',
      { patEligible: false, allowedClients: ['third_party'], thirdPartySafe: true },
      'has a consent line exactly when',
    ],
    [
      'a first-party scope with a consent line',
      'gateway:models.read',
      { consentText: 'Read your models' },
      'has a consent line exactly when',
    ],
    [
      'a consent line with markup',
      'mcp:tools.read',
      {
        patEligible: false,
        allowedClients: ['third_party'],
        thirdPartySafe: true,
        consentText: 'Read <b>tools</b>',
      },
      'consent line must be one line of plain text',
    ],
    ['an unregistered client', 'gateway:models.read', { allowedClients: ['kilo-tv'] }, 'kilo-tv'],
  ] as const)('fails %s', (_name, scope, overrides, message) => {
    expect(check(scope, overrides)).toEqual([expect.stringContaining(message)]);
  });

  it('fails an exchange scope that is not delegable, or that no scope or two scopes delegate to', () => {
    const exchange = {
      ...base,
      audience: 'kilo-api',
      patEligible: false,
      delegable: true,
      issuance: 'token_exchange',
    } as const;
    const source = {
      ...base,
      audience: 'kilo-mcp',
      patEligible: false,
      delegatesTo: ['kilo-api:mcp.read'],
    };
    expect(
      scopeRegistryProblems({ 'kilo-mcp:catalog.read': source, 'kilo-api:mcp.read': exchange })
    ).toEqual([]);
    expect(
      scopeRegistryProblems({
        'kilo-mcp:catalog.read': source,
        'kilo-api:mcp.read': { ...exchange, delegable: false },
      })
    ).toEqual([expect.stringContaining('is minted by the exchange but')]);
    expect(scopeRegistryProblems({ 'kilo-api:mcp.read': exchange })).toEqual([
      expect.stringContaining('exchange target of other than exactly one scope'),
    ]);
    expect(
      scopeRegistryProblems({
        'kilo-mcp:catalog.read': source,
        'kilo-mcp:tools.read': source,
        'kilo-api:mcp.read': exchange,
      })
    ).toEqual([expect.stringContaining('exchange target of other than exactly one scope')]);
    expect(
      scopeRegistryProblems({
        'kilo-mcp:catalog.read': { ...source, delegable: true },
        'kilo-api:mcp.read': exchange,
      })
    ).toEqual([expect.stringContaining('delegates but is itself delegable')]);
  });
});

describe('the development fixture scopes', () => {
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const source = (path: string) => join(sourceRoot, path);
  const FIXTURES = source('scopes/development-fixtures.ts');

  it('are named fixture:*, follow the registry rules, and the registry holds none', () => {
    const names = Object.keys(DEVELOPMENT_FIXTURE_SCOPES);
    expect(names.length).toBeGreaterThan(0);
    for (const scope of names) expect(scope).toMatch(/^fixture:[a-z][a-z0-9.-]*$/);
    expect(scopeRegistryProblems(DEVELOPMENT_FIXTURE_SCOPES)).toEqual([]);
    expect(Object.keys(UTS_SCOPE_REGISTRY).filter(scope => scope.startsWith('fixture:'))).toEqual(
      []
    );
    expect(utsScopeEntry('fixture:read')).toBeNull();
    expect(developmentScopes('fixture:read')).toEqual(DEVELOPMENT_FIXTURE_SCOPES['fixture:read']);
    expect(developmentScopes(KILO_API_PROFILE_READ_SCOPE)).toEqual(
      utsScopeEntry(KILO_API_PROFILE_READ_SCOPE)
    );
  });

  it('are reached only from the development entry, never from the deployed entry', () => {
    const deployed = importClosure(source('index.ts'));
    expect(deployed.has(source('http.ts'))).toBe(true);
    expect(deployed.has(source('oauth/routes.ts'))).toBe(true);
    expect(deployed.has(FIXTURES)).toBe(false);
    expect(deployed.has(source('dev.ts'))).toBe(false);
    for (const file of deployed) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/fixture:|development-fixtures/);
    }
    expect(importClosure(source('dev-index.ts')).has(FIXTURES)).toBe(true);
  });
});
