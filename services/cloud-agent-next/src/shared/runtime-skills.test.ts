import { describe, expect, it } from 'vitest';
import { RuntimeSkillSchema, RuntimeSkillsSchema } from './runtime-profile.js';

describe('skills.sh runtime references', () => {
  it('accepts a qualified GitHub skill alongside a bundled skill', () => {
    const skills = [
      { name: 'find-skills', source: 'vercel-labs/skills' },
      { name: 'review', rawMarkdown: '# Review', files: { 'guide.md': 'Guide' } },
    ];
    expect(RuntimeSkillsSchema.parse(skills)).toEqual(skills);
  });

  it.each([
    '--help',
    'owner/repo/skill',
    'owner/repo@skill',
    'https://github.com/owner/repo',
    'owner/-repo',
    'owner/..',
    'owner/.',
    'owner/a..b',
    'owner/repo;pwd',
    'owner/repo\n',
    'owner/repo --all',
    '../repo',
    'owner/repo%20',
  ])('rejects unsafe or unqualified source %j', source => {
    expect(RuntimeSkillSchema.safeParse({ name: 'review', source }).success).toBe(false);
  });

  it('rejects references mixed with bundled content and unsafe names', () => {
    expect(
      RuntimeSkillSchema.safeParse({
        name: 'review',
        source: 'owner/repo',
        rawMarkdown: '# Review',
      }).success
    ).toBe(false);
    expect(RuntimeSkillSchema.safeParse({ name: '../review', source: 'owner/repo' }).success).toBe(
      false
    );
    expect(
      RuntimeSkillsSchema.safeParse(
        Array.from({ length: 51 }, () => ({ name: 'review', source: 'owner/repo' }))
      ).success
    ).toBe(false);
  });
});
