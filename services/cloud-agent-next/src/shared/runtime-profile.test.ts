import { describe, expect, it } from 'vitest';
import { RESERVED_AGENT_SLUGS } from '@kilocode/app-shared/agent-profile';
import {
  isReservedRuntimeAgentSlug,
  PersistedRuntimeAgentsSchema,
  projectStoredRouteSpec,
  projectStoredRuntimeAgents,
  RESERVED_RUNTIME_AGENT_SLUGS,
  RuntimeAgentSchema,
} from './runtime-profile.js';

function agent(slug: string) {
  return { slug, name: slug, config: { prompt: `You are ${slug}` } };
}

describe('shared agent id list parity', () => {
  it('keeps the runtime list equal to the shared profile list', () => {
    expect([...RESERVED_RUNTIME_AGENT_SLUGS].sort()).toEqual([...RESERVED_AGENT_SLUGS].sort());
  });

  it('agrees with the shared helper on every id', () => {
    for (const slug of RESERVED_AGENT_SLUGS) {
      expect(isReservedRuntimeAgentSlug(slug), slug).toBe(true);
    }
    expect(isReservedRuntimeAgentSlug('reviewer')).toBe(false);
  });
});

describe('RuntimeAgentSchema CLI-owned ids', () => {
  it.each(['general', 'explore', 'compaction', 'title', 'summary'])(
    'rejects an id that belongs to the CLI: %j',
    slug => {
      expect(RuntimeAgentSchema.safeParse(agent(slug)).success).toBe(false);
    }
  );

  it('accepts a free slug and keeps the entry', () => {
    const reviewer = agent('reviewer');

    expect(RuntimeAgentSchema.parse(reviewer)).toEqual(reviewer);
  });
});

describe('PersistedRuntimeAgentsSchema', () => {
  it('drops an entry with a CLI-owned id and keeps the rest verbatim', () => {
    const reviewer = agent('reviewer');

    expect(PersistedRuntimeAgentsSchema.parse([reviewer, agent('explore')])).toEqual([reviewer]);
  });

  it('keeps undefined undefined', () => {
    expect(PersistedRuntimeAgentsSchema.parse(undefined)).toBeUndefined();
  });

  it('passes a non-array value through the projection unchanged', () => {
    const notAList = { slug: 'explore' };

    expect(projectStoredRuntimeAgents(notAList)).toBe(notAList);
    expect(PersistedRuntimeAgentsSchema.safeParse(notAList).success).toBe(false);
  });
});

describe('projectStoredRouteSpec', () => {
  it('projects both the skill files and the runtime agents of a stored spec', () => {
    const spec = {
      model: 'kilo/anthropic/claude-sonnet-4.5',
      runtimeSkills: [
        {
          name: 'review',
          rawMarkdown: '# Review',
          files: { 'scripts/run.sh': 'echo ok', './bad.md': 'drop' },
        },
      ],
      runtimeAgents: [agent('reviewer'), agent('explore')],
    };

    expect(projectStoredRouteSpec(spec)).toEqual({
      model: 'kilo/anthropic/claude-sonnet-4.5',
      runtimeSkills: [
        { name: 'review', rawMarkdown: '# Review', files: { 'scripts/run.sh': 'echo ok' } },
      ],
      runtimeAgents: [agent('reviewer')],
    });
  });

  it('leaves a spec with neither key unchanged', () => {
    const spec = { model: 'kilo/anthropic/claude-sonnet-4.5' };

    expect(projectStoredRouteSpec(spec)).toBe(spec);
  });
});
