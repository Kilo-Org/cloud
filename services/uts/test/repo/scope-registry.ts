import {
  THIRD_PARTY_CLIENTS,
  UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
  UTS_CREDENTIAL_SCOPES,
  UTS_ORG_ROLES,
  UtsEnvironmentSchema,
  UtsScopeSchema,
  type UtsFirstPartyClient,
  type UtsScopeEntry,
  audienceOfScope,
  firstPartyClient,
} from '@kilocode/uts-contracts';

/** Design 5.12: an admin token lives 5 minutes. */
const PRIVILEGED_MAX_LIFETIME_SECONDS = 300;

/**
 * The rules every scope registry entry follows (design 5.3, 5.9, 5.12), one message per broken
 * rule:
 * - the scope is `<audience>:<permission>` and its entry names that audience;
 * - an access token for it lives at most 10 minutes, 5 for a privileged scope;
 * - every allowed client is a registered first-party client (`UTS_FIRST_PARTY_CLIENTS`) or
 *   `third_party`, and the third-party-safe flag says exactly whether `third_party` is allowed;
 * - a third-party-safe or PAT-eligible scope is neither privileged, nor behind a step-up, nor held
 *   by a staff list; a scope that changes credentials is never PAT-eligible, so a PAT never makes a
 *   PAT;
 * - a privileged scope needs a passkey step-up;
 * - a scope that needs a session is never PAT-eligible, because a PAT names no session;
 * - a scope needs the `org` claim exactly when its subjects are the members of an organization,
 *   and the roles those subjects need are `any` or a non-empty list of distinct membership roles;
 *   a scope limited to listed roles is neither third-party-safe nor PAT-eligible, because only
 *   the first-party mint statements read the member's role;
 * - a privileged, step-up, staff-only or credential-changing scope is never delegable;
 * - a scope that only the broker exchange mints (`issuance: 'token_exchange'`) is delegable, not
 *   PAT-eligible, delegates to nothing, and is the `delegatesTo` target of exactly one scope;
 * - a `delegatesTo` source is a grant scope that is not delegable itself, and each target is a
 *   registered exchange scope;
 * - a scope has a consent line exactly when a third-party client can ask for it at `/authorize`
 *   (third-party-safe and minted from a grant): one line of plain text, at most 200 characters.
 */
export function scopeRegistryProblems(registry: Readonly<Record<string, UtsScopeEntry>>): string[] {
  const problems: string[] = [];
  for (const [scope, entry] of Object.entries(registry)) {
    const problem = (text: string) => problems.push(`${scope}: ${text}`);
    if (!UtsScopeSchema.safeParse(scope).success) problem('is not <audience>:<permission>');
    else if (entry.audience !== audienceOfScope(scope)) problem('names another audience');
    const maxLifetime = entry.privileged
      ? PRIVILEGED_MAX_LIFETIME_SECONDS
      : UTS_ACCESS_TOKEN_LIFETIME_SECONDS;
    if (
      !Number.isInteger(entry.maxLifetimeSeconds) ||
      entry.maxLifetimeSeconds <= 0 ||
      entry.maxLifetimeSeconds > maxLifetime
    ) {
      problem(`max lifetime must be 1 to ${maxLifetime} seconds`);
    }
    if (entry.allowedClients.length === 0) problem('allows no client');
    if (new Set(entry.allowedClients).size !== entry.allowedClients.length) {
      problem('lists a client twice');
    }
    for (const client of entry.allowedClients) {
      if (client !== THIRD_PARTY_CLIENTS && firstPartyClient(client) === null) {
        problem(`allows ${client}, which is not a registered first-party client`);
      }
    }
    if (entry.thirdPartySafe !== entry.allowedClients.includes(THIRD_PARTY_CLIENTS)) {
      problem('third-party-safe flag and allowed clients disagree');
    }
    const highRisk = entry.privileged || entry.stepUp || entry.subjects.kind === 'staff';
    if (entry.delegable && (highRisk || UTS_CREDENTIAL_SCOPES.includes(scope))) {
      problem('is delegable but privileged, behind a step-up, staff-only or credential-changing');
    }
    if (entry.thirdPartySafe && highRisk) {
      problem('is third-party-safe but privileged, behind a step-up or staff-only');
    }
    if (entry.patEligible && highRisk) {
      problem('is PAT-eligible but privileged, behind a step-up or staff-only');
    }
    if (entry.patEligible && UTS_CREDENTIAL_SCOPES.includes(scope)) {
      problem('changes credentials but is PAT-eligible');
    }
    if (entry.privileged && !entry.stepUp) problem('is privileged without a step-up');
    if (entry.requiresSession && entry.patEligible) {
      problem('needs a session but is PAT-eligible; a PAT names no session');
    }
    if (entry.requiresOrgClaim !== (entry.subjects.kind === 'org_member')) {
      problem('org claim need and organization-member subjects disagree');
    }
    if (entry.subjects.kind === 'org_member' && entry.subjects.roles !== 'any') {
      const roles = entry.subjects.roles;
      if (
        roles.length === 0 ||
        new Set(roles).size !== roles.length ||
        roles.some(role => !UTS_ORG_ROLES.includes(role))
      ) {
        problem('organization roles must be any or distinct membership roles');
      }
      if (entry.thirdPartySafe || entry.patEligible) {
        problem('is limited to listed roles but third-party-safe or PAT-eligible');
      }
    }
    if (entry.issuance === 'token_exchange') {
      if (!entry.delegable || entry.patEligible || entry.delegatesTo.length > 0) {
        problem('is minted by the exchange but not delegable, PAT-eligible or delegating');
      }
      const sources = Object.values(registry).filter(other => other.delegatesTo.includes(scope));
      if (sources.length !== 1) problem('is the exchange target of other than exactly one scope');
    }
    if (entry.delegatesTo.length > 0 && (entry.issuance !== 'grant' || entry.delegable)) {
      problem('delegates but is itself delegable or minted by the exchange');
    }
    for (const target of entry.delegatesTo) {
      const targetEntry = Object.hasOwn(registry, target) ? registry[target] : undefined;
      if (targetEntry?.issuance !== 'token_exchange') {
        problem(`delegates to ${target}, which is not a registered exchange scope`);
      }
    }
    const consentable = entry.thirdPartySafe && entry.issuance === 'grant';
    if (consentable !== (entry.consentText !== null)) {
      problem('has a consent line exactly when a third-party client can ask for it');
    }
    if (
      entry.consentText !== null &&
      (entry.consentText.length === 0 ||
        entry.consentText.length > 200 ||
        /[\p{Cc}<>]/u.test(entry.consentText))
    ) {
      problem('consent line must be one line of plain text, 1 to 200 characters');
    }
  }
  return problems;
}

/** A loopback web origin, which only development may use. */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

/** RFC 8252 section 7.1: a reverse-domain scheme, one slash, and a path. */
const PRIVATE_USE_REDIRECT = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

/**
 * The rules every first-party client follows (design 5.5, 5.9), one message per broken rule:
 * - client ids are unique;
 * - a public native client receives its code on a loopback path (desktop, RFC 8252 section 7.3)
 *   or one private-use-scheme URI with a reverse-domain scheme (mobile, RFC 8252 section 7.1), and
 *   a mobile client needs device attestation (design 5.5);
 * - a confidential web client authenticates with a private-key JWT, and every environment lists at
 *   least one redirect URI: an exact URL with a path and no query or fragment, HTTPS in staging and
 *   production, and HTTPS or a loopback origin in development.
 */
export function firstPartyClientProblems(clients: readonly UtsFirstPartyClient[]): string[] {
  const problems: string[] = [];
  if (new Set(clients.map(client => client.clientId)).size !== clients.length) {
    problems.push('a client id is registered twice');
  }
  for (const client of clients) {
    const problem = (text: string) => problems.push(`${client.clientId}: ${text}`);
    if (client.kind === 'public_native') {
      const { redirect } = client;
      if (client.clientClass === 'desktop') {
        if (redirect.kind !== 'loopback' || !/^\/[a-z0-9/_-]*$/.test(redirect.path)) {
          problem('a desktop client receives its code on a loopback path');
        }
      } else {
        if (redirect.kind !== 'private_use_scheme' || !PRIVATE_USE_REDIRECT.test(redirect.uri)) {
          problem('a mobile client receives its code on one reverse-domain private-use URI');
        }
        if (client.attestation !== 'required') problem('a mobile client needs device attestation');
      }
      continue;
    }
    if (client.tokenEndpointAuthMethod !== 'private_key_jwt') {
      problem('a confidential client authenticates with private_key_jwt');
    }
    for (const environment of UtsEnvironmentSchema.options) {
      const uris = client.redirectUris[environment];
      if (uris.length === 0) problem(`lists no ${environment} redirect URI`);
      for (const uri of uris) {
        let url: URL;
        try {
          url = new URL(uri);
        } catch {
          problem(`${environment} redirect URI ${uri} is not a URL`);
          continue;
        }
        const secure = url.protocol === 'https:';
        const loopback = environment === 'development' && LOOPBACK.test(url.origin);
        if (
          (!secure && !loopback) ||
          url.pathname === '/' ||
          url.search !== '' ||
          url.hash !== '' ||
          url.href !== uri
        ) {
          problem(`${environment} redirect URI ${uri} is not an exact HTTPS URL with a path`);
        }
      }
    }
  }
  return problems;
}
