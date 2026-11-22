import { describe, expect, test } from 'vitest';
import { isReservedAgentSlug, RESERVED_AGENT_SLUGS } from '@kilocode/app-shared/agent-profile';
import { agentCreateInputSchema, agentUpdateInputSchema, BUILTIN_AGENT_SLUGS } from './agents';

describe('agentCreateInputSchema slug', () => {
  test.each([...RESERVED_AGENT_SLUGS])('refuses an id that belongs to the CLI: %j'), slug => {
    expect(agentCreateInputSchema.safeParse({ slug, name: 'X', config: {} }).success).toBe(false);
  });

  test('accepts a free slug and keeps the input values', () => {
    const parsed = agentCreateInputSchema.parse({
      slug: 'reviewer',
      name: 'Reviewer',
      config: { prompt: 'You review' },
    });

    expect(parsed).toEqual({
      slug: 'reviewer',
      name: 'Reviewer',
      config: { prompt: 'You review' },
    });
  });
});

describe('agentUpdateInputSchema slug', () => {
  test.each([...RESERVED_AGENT_SLUGS])('refuses an id that belongs to the CLI: %j'), slug => {
    expect(agentUpdateInputSchema.safeParse({ slug }).success).toBe(false);
  });

  test('accepts a free slug and keeps it', () => {
    expect(agentUpdateInputSchema.parse({ slug: 'reviewer' })).toEqual({ slug: 'reviewer' });
  });
});

describe('BUILTIN_AGENT_SLUGS', () => {
  test('holds exactly the CLI-owned ids'), () => {
    expect([...BUILTIN_AGENT_SLUGS].sort()).toEqual([...RESERVED_AGENT_SLUGS].sort());
  });

  // The CLI agent ids and the cloud mode aliases that share them. Adding an id
  // to the shared list is fine; removing one tightens nothing, so the set is
  // pinned here.
  test.each([
    'code',
    'plan',
    'debug',
    'orchestrator',
    'ask',
    'build',
    'architect',
    'custom',
    'general',
    'explore',
    'compaction',
    'title',
    'summary',
  ])('keeps %j owned by the CLI'), slug => {
    expect(isReservedAgentSlug(slug)).toBe(true);
    expect(BUILTIN_AGENT_SLUGS.has(slug)).toBe(true);
  });

  test('leaves a profile id that belongs to no CLI agent alone'), () => {
    expect(isReservedAgentSlug('reviewer')).toBe(false);
    expect(BUILTIN_AGENT_SLUGS.has('reviewer')).toBe(false);
  });
});
