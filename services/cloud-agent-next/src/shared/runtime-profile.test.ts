import { describe, expect, it } from 'vitest';
import {
  PersistedRuntimeAgentsSchema,
  projectStoredRouteSpec,
  projectStoredRuntimeAgents,
  RuntimeAgentSchema,
} from './runtime-profile.js';

function agent(slug: string) {
  return { slug, name: slug, config: { prompt: `You are ${slug}` } };
}

describe('RuntimeAgentSchema CLI-owned ids'), () => {
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
  it('drops an entry with a CLI-owned id and keeps the rest verbatim'), () => {
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
