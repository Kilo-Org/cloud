import * as z from 'zod';
import vectors from './conformance-vectors.json';
import { evaluateOrgDecisionForPatterns, finalClientDecision } from './evaluate';
import {
  PermissionActionSchema,
  PermissionEnforcementSchema,
  PermissionTierSchema,
  TOOL_LEVEL_PERMISSIONS,
} from './types';

const VectorSchema = z.object({
  name: z.string(),
  policy: z.object({
    enforcement: PermissionEnforcementSchema,
    defaultEffect: PermissionActionSchema,
    rules: z.array(
      z.object({
        id: z.string(),
        tier: PermissionTierSchema,
        permission: z.string(),
        pattern: z.string(),
      })
    ),
  }),
  request: z.object({ permission: z.string(), patterns: z.array(z.string()).min(1) }),
  localResult: PermissionActionSchema,
  expectedOrgDecision: z.object({
    decision: PermissionActionSchema,
    ruleId: z.string().optional(),
    tier: PermissionTierSchema.optional(),
  }),
  expectedFinal: PermissionActionSchema,
});

const cases = z.array(VectorSchema).parse(vectors);

describe('permission conformance vectors', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const org = evaluateOrgDecisionForPatterns(c.policy, c.request.permission, c.request.patterns);
    expect(org).toEqual(c.expectedOrgDecision);
    expect(finalClientDecision(c.policy, org.decision, c.localResult)).toBe(c.expectedFinal);
  });

  it('has unique names', () => {
    expect(new Set(cases.map(c => c.name)).size).toBe(cases.length);
  });

  it('covers every truth-table cell, tier, defaultEffect, and mode', () => {
    const cells = new Set(
      cases
        .filter(c => c.policy.enforcement === 'enforce')
        .map(c => `${c.localResult}/${c.expectedOrgDecision.decision}`)
    );
    for (const local of ['allow', 'ask', 'deny']) {
      for (const org of ['allow', 'ask', 'deny']) expect(cells).toContain(`${local}/${org}`);
    }
    const tiers = new Set(cases.map(c => c.expectedOrgDecision.tier));
    for (const tier of PermissionTierSchema.options) expect(tiers).toContain(tier);
    const defaults = new Set(
      cases.filter(c => !c.expectedOrgDecision.tier).map(c => c.policy.defaultEffect)
    );
    for (const effect of PermissionActionSchema.options) expect(defaults).toContain(effect);
    const modes = new Set(cases.map(c => c.policy.enforcement));
    for (const mode of PermissionEnforcementSchema.options) expect(modes).toContain(mode);
    expect(cases.some(c => c.request.patterns.length > 1)).toBe(true);
    expect(
      cases.some(c => (TOOL_LEVEL_PERMISSIONS as readonly string[]).includes(c.request.permission))
    ).toBe(true);
  });
});
