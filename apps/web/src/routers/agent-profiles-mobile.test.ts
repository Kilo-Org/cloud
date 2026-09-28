import { describe, test, expect } from '@jest/globals';
import { agentProfilesMobileRouter } from '../../../../packages/trpc/src/agent-profiles-mobile';

const procedures = (
  agentProfilesMobileRouter as unknown as {
    _def: { procedures: Record<string, unknown> };
  }
)._def.procedures;

describe('agentProfilesMobileRouter', () => {
  test.each([
    // read procedures
    'list',
    'listCombined',
    'get',
    // profile mutations the mobile profiles screens call
    'create',
    'update',
    'delete',
    'setAsDefault',
    'clearDefault',
    // profile var mutations
    'setVar',
    'deleteVar',
    // command mutations
    'setCommands',
    // skill mutations
    'createCustomSkill',
    'updateSkill',
    'deleteSkill',
    'setSkillEnabled',
  ])('mounts the %s procedure', name => {
    expect(procedures[name]).toBeDefined();
  });
});
