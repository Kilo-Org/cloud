import {
  THIRD_PARTY_CLIENTS,
  UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
  UTS_CREDENTIAL_SCOPES,
  UtsScopeSchema,
  type UtsScopeEntry,
  audienceOfScope,
} from '@kilocode/uts-contracts';
import { identifyClient } from '../../src/oauth/clients';

/** Design 5.12: an admin token lives 5 minutes. */
const PRIVILEGED_MAX_LIFETIME_SECONDS = 300;

/**
 * The rules every scope registry entry follows (design 5.3, 5.9, 5.12), one message per broken
 * rule:
 * - the scope is `<audience>:<permission>` and its entry names that audience;
 * - an access token for it lives at most 10 minutes, 5 for a privileged scope;
 * - every allowed client is a registered first-party client or `third_party`, and the
 *   third-party-safe flag says exactly whether `third_party` is allowed;
 * - a third-party-safe or PAT-eligible scope is neither privileged, nor behind a step-up, nor held
 *   by a staff list; a scope that changes credentials is never PAT-eligible, so a PAT never makes a
 *   PAT;
 * - a privileged scope needs a passkey step-up.
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
      if (client !== THIRD_PARTY_CLIENTS && identifyClient(client).kind !== 'first_party') {
        problem(`allows ${client}, which is not a registered first-party client`);
      }
    }
    if (entry.thirdPartySafe !== entry.allowedClients.includes(THIRD_PARTY_CLIENTS)) {
      problem('third-party-safe flag and allowed clients disagree');
    }
    const highRisk = entry.privileged || entry.stepUp || entry.subjects.kind === 'staff';
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
  }
  return problems;
}
