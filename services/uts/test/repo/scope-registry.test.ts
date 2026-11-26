import {
  UTS_ACCOUNT_AUDIENCE,
  UTS_BOT_KEYS_MANAGE_SCOPE,
  UTS_PATS_MANAGE_SCOPE,
  UTS_PROBE_READ_SCOPE,
  UTS_SCOPE_REGISTRY,
  type UtsScopeEntry,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { scopeRegistryProblems } from './scope-registry';

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
        patEligible: false,
        thirdPartySafe: false,
      });
    }
    expect(utsScopeEntry(UTS_PROBE_READ_SCOPE)).toMatchObject({
      audience: UTS_ACCOUNT_AUDIENCE,
      patEligible: true,
    });
  });

  it('knows no scope it does not list, including object property names', () => {
    for (const scope of ['gateway:unknown.read', 'toString', '__proto__', 'constructor']) {
      expect(utsScopeEntry(scope)).toBeNull();
    }
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
      { thirdPartySafe: true },
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
  ] as const)('fails %s', (_name, scope, overrides, message) => {
    expect(check(scope, overrides)).toEqual([expect.stringContaining(message)]);
  });
});
