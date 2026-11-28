import { KILO_GATEWAY_INFERENCE_SCOPE, utsScopeEntry } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import {
  BotTokenPolicySchema,
  botTokenLifetimeSeconds,
  botTokenPolicies,
} from '../../src/bot-token/policy';

/** The bot-token policy loader (src/bot-token/policy.ts): the switch and every load rule. */

const policy = {
  workload: 'bouncer-watch',
  account: 'bot-internal-bouncer-watch',
  org: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  scopes: [KILO_GATEWAY_INFERENCE_SCOPE, 'kilo-api:organizations.read'],
  lifetimeSeconds: 3600,
};

const load = (value: unknown) =>
  botTokenPolicies(
    { BOT_TOKEN_POLICIES: typeof value === 'string' ? value : JSON.stringify(value) },
    utsScopeEntry
  );

describe('bot-token policies', () => {
  it('stay off without the var, with an empty var and with an empty list', () => {
    expect(botTokenPolicies({}, utsScopeEntry)).toEqual({ status: 'off' });
    expect(load('  ')).toEqual({ status: 'off' });
    expect(load([])).toEqual({ status: 'off' });
  });

  it('turn on with valid policies, one workload holding two bot accounts', () => {
    const second = { ...policy, account: 'bot-internal-other' };
    expect(load([policy, second])).toEqual({ status: 'on', policies: [policy, second] });
  });

  it('stay off and name the rule for a var that is not JSON or breaks the schema', () => {
    expect(load('{')).toEqual({
      status: 'misconfigured',
      problems: ['BOT_TOKEN_POLICIES is not JSON'],
    });
    for (const broken of [
      { ...policy, account: 'oauth/human-user' },
      { ...policy, workload: 'Bouncer Watch' },
      { ...policy, org: 'not-a-uuid' },
      { ...policy, scopes: [] },
      { ...policy, lifetimeSeconds: 3601 },
      { ...policy, lifetimeSeconds: 59 },
      { ...policy, extra: true },
    ]) {
      expect(load([broken]).status).toBe('misconfigured');
    }
  });

  it('refuse two policies for one workload and bot account, and a repeated scope', () => {
    expect(load([policy, { ...policy, scopes: [KILO_GATEWAY_INFERENCE_SCOPE] }])).toEqual({
      status: 'misconfigured',
      problems: ['two policies share a workload and bot account'],
    });
    expect(
      load([{ ...policy, scopes: [KILO_GATEWAY_INFERENCE_SCOPE, KILO_GATEWAY_INFERENCE_SCOPE] }])
    ).toEqual({
      status: 'misconfigured',
      problems: ['policy bouncer-watch bot-internal-bouncer-watch: scopes contains a duplicate'],
    });
  });

  it('refuse an unregistered, session-bound, broker-only, credential or UTS scope', () => {
    const at = 'policy bouncer-watch bot-internal-bouncer-watch';
    expect(load([{ ...policy, scopes: ['kilo-gateway:unknown'] }])).toEqual({
      status: 'misconfigured',
      problems: [`${at}: a scope is not registered`],
    });
    for (const scope of [
      'kilo-api:sessions.write',
      'kilo-api:mcp.read',
      'uts:pats.manage',
      'uts:probe.read',
    ]) {
      expect(load([{ ...policy, scopes: [scope] }])).toEqual({
        status: 'misconfigured',
        problems: [`${at}: a scope is session-bound, privileged, staff-only or a UTS scope`],
      });
    }
  });

  it('let a PAT-eligible scope live the policy lifetime and cap any other at its registered maximum', () => {
    const parsed = BotTokenPolicySchema.parse(policy);
    const gateway = utsScopeEntry(KILO_GATEWAY_INFERENCE_SCOPE);
    const organizations = utsScopeEntry('kilo-api:organizations.read');
    if (gateway === null || organizations === null) throw new Error('scopes are registered');
    expect(botTokenLifetimeSeconds(parsed, gateway)).toBe(3600);
    expect(botTokenLifetimeSeconds(parsed, organizations)).toBe(600);
    expect(botTokenLifetimeSeconds({ ...parsed, lifetimeSeconds: 300 }, organizations)).toBe(300);
  });
});
