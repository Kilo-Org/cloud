import {
  evaluateOrgDecision,
  evaluateOrgDecisionForPatterns,
  finalClientDecision,
} from './evaluate';
import type { PermissionPolicy } from './types';

const policy: PermissionPolicy = {
  enforcement: 'enforce',
  defaultEffect: 'ask',
  rules: [
    { id: 'fd', tier: 'final_deny', permission: 'bash', pattern: 'rm -rf *' },
    { id: 'ba', tier: 'broad_allow', permission: 'bash', pattern: 'rm *' },
    { tier: 'specific_deny', permission: 'bash', pattern: 'curl *' },
  ],
};

describe('evaluateOrgDecision', () => {
  it('picks the highest matching tier regardless of order', () => {
    expect(evaluateOrgDecision(policy, { permission: 'bash', pattern: 'rm -rf /' })).toEqual({
      decision: 'deny',
      ruleId: 'fd',
      tier: 'final_deny',
    });
  });

  it('omits tier and ruleId for defaultEffect decisions', () => {
    expect(evaluateOrgDecision(policy, { permission: 'bash', pattern: 'ls' })).toEqual({
      decision: 'ask',
    });
  });

  it('omits ruleId for rules without an id', () => {
    expect(evaluateOrgDecision(policy, { permission: 'bash', pattern: 'curl x' })).toEqual({
      decision: 'deny',
      tier: 'specific_deny',
    });
  });

  it('requires the permission to match', () => {
    expect(evaluateOrgDecision(policy, { permission: 'read', pattern: 'rm -rf /' })).toEqual({
      decision: 'ask',
    });
  });
});

describe('evaluateOrgDecisionForPatterns', () => {
  it('returns the strictest decision', () => {
    expect(evaluateOrgDecisionForPatterns(policy, 'bash', ['rm a', 'ls']).decision).toBe('ask');
    expect(evaluateOrgDecisionForPatterns(policy, 'bash', ['ls', 'curl x'])).toEqual({
      decision: 'deny',
      tier: 'specific_deny',
    });
  });

  it('falls back to defaultEffect with no patterns', () => {
    expect(evaluateOrgDecisionForPatterns(policy, 'bash', [])).toEqual({ decision: 'ask' });
  });
});

describe('finalClientDecision', () => {
  it('applies the org decision only when enforcing', () => {
    expect(finalClientDecision(policy, 'deny', 'allow')).toBe('deny');
    expect(finalClientDecision({ ...policy, enforcement: 'shadow' }, 'deny', 'allow')).toBe(
      'allow'
    );
    expect(finalClientDecision({ ...policy, enforcement: 'off' }, 'deny', 'ask')).toBe('ask');
  });
});
