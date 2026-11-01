import { describe, expect, it } from 'vitest';

import { isRedundantAgentSlug } from './agent-profile';

describe('isRedundantAgentSlug', () => {
  it('matches a slug that repeats the name in lowercase', () => {
    expect(isRedundantAgentSlug('Reviewer', 'reviewer')).toBe(true);
    expect(isRedundantAgentSlug('Triager', 'triager')).toBe(true);
  });

  it('matches across the separators a name uses and a slug cannot', () => {
    expect(isRedundantAgentSlug('Code Reviewer', 'code-reviewer')).toBe(true);
    expect(isRedundantAgentSlug('code_reviewer', 'code-reviewer')).toBe(true);
    expect(isRedundantAgentSlug('  Code   Reviewer ', 'code--reviewer')).toBe(true);
  });

  it('keeps a slug that names something the display name does not', () => {
    expect(isRedundantAgentSlug('Reviewer', 'review')).toBe(false);
    expect(isRedundantAgentSlug('Code Reviewer', 'reviewer')).toBe(false);
    expect(isRedundantAgentSlug('Reviewer', 'reviewer-pro')).toBe(false);
    expect(isRedundantAgentSlug('Reviewer 2', 'reviewer')).toBe(false);
  });

  it('keeps the slug of a name the slug alphabet cannot spell', () => {
    expect(isRedundantAgentSlug('مراجع', 'reviewer')).toBe(false);
    expect(isRedundantAgentSlug('主代理', 'main')).toBe(false);
  });

  it('never treats an empty slug as redundant', () => {
    expect(isRedundantAgentSlug('', '')).toBe(false);
    expect(isRedundantAgentSlug('Reviewer', '')).toBe(false);
  });
});
