import { describe, expect, it } from '@jest/globals';
import type { CouncilSpecialist } from '@kilocode/db/schema-types';
import { COUNCIL_RESULT_MARKER_TAG } from '@kilocode/worker-utils/code-review-council';
import {
  buildCouncilOrchestratorPrompt,
  buildCouncilRuntimeAgents,
  buildSpecialistAgentPrompt,
} from './council-prompt';

const specialist = (
  overrides: Partial<CouncilSpecialist> & Pick<CouncilSpecialist, 'id'>
): CouncilSpecialist => ({
  role: 'security',
  name: 'Security',
  enabled: true,
  required: false,
  lens: 'security concerns',
  ...overrides,
});

describe('buildCouncilRuntimeAgents', () => {
  it('resolves each specialist to its own model/effort, falling back to the review default', () => {
    const agents = buildCouncilRuntimeAgents({
      specialists: [
        specialist({
          id: 'security',
          name: 'Security',
          model_slug: 'anthropic/x',
          thinking_effort: 'high',
        }),
        specialist({ id: 'performance', name: 'Performance', role: 'performance' }),
      ],
      defaultModel: 'default/model',
      defaultVariant: 'low',
    });

    expect(agents[0]).toMatchObject({
      slug: 'security',
      name: 'Security',
      config: { mode: 'subagent', model: 'anthropic/x', variant: 'high' },
    });
    // Falls back to the review default model + variant.
    expect(agents[1]).toMatchObject({
      slug: 'performance',
      config: { mode: 'subagent', model: 'default/model', variant: 'low' },
    });
    // Each sub-agent carries a prompt + description.
    expect(agents[0].config.prompt).toContain('Security');
    expect(agents[0].config.description).toBe('security concerns');
  });

  it('omits variant when neither the specialist nor the default has one (model still required)', () => {
    const [agent] = buildCouncilRuntimeAgents({
      specialists: [specialist({ id: 'security' })],
      defaultModel: 'default/model',
    });
    expect(agent.config.model).toBe('default/model');
    expect(agent.config.variant).toBeUndefined();
  });

  it('does NOT inherit the default variant for a specialist on its own model', () => {
    const [agent] = buildCouncilRuntimeAgents({
      // Own model, no effort override → must not borrow the base model's variant.
      specialists: [specialist({ id: 'security', model_slug: 'anthropic/x' })],
      defaultModel: 'default/model',
      defaultVariant: 'high',
    });
    expect(agent.config.model).toBe('anthropic/x');
    expect(agent.config.variant).toBeUndefined();
  });

  it('inherits the default variant only when the specialist also inherits the default model', () => {
    const [agent] = buildCouncilRuntimeAgents({
      specialists: [specialist({ id: 'security' })],
      defaultModel: 'default/model',
      defaultVariant: 'high',
    });
    expect(agent.config.model).toBe('default/model');
    expect(agent.config.variant).toBe('high');
  });
});

describe('buildCouncilOrchestratorPrompt', () => {
  it('includes the manifest marker contract, the specialist roster, and the base prompt', () => {
    const prompt = buildCouncilOrchestratorPrompt({
      basePrompt: 'BASE REVIEW CONTEXT',
      specialists: [
        specialist({ id: 'security', name: 'Security' }),
        specialist({ id: 'performance', name: 'Performance', role: 'performance' }),
      ],
      aggregationStrategy: 'majority',
    });

    expect(prompt).toContain(COUNCIL_RESULT_MARKER_TAG);
    expect(prompt).toContain('subagent_type "security"');
    expect(prompt).toContain('subagent_type "performance"');
    expect(prompt).toContain('BASE REVIEW CONTEXT');
    // Coordinator must not compute the decision itself.
    expect(prompt.toLowerCase()).toContain('do not compute an overall decision');
  });
});

describe('buildSpecialistAgentPrompt', () => {
  it('scopes the specialist to its lens and asks for a structured vote + findings', () => {
    const prompt = buildSpecialistAgentPrompt(specialist({ id: 'security', name: 'Security' }));
    expect(prompt).toContain('security concerns');
    expect(prompt).toContain('"vote"');
    expect(prompt).toContain('findings');
  });
});
