import { describe, expect, it } from 'vitest';
import {
  acceptedRuntimeSkillFiles,
  RuntimeSkillSchema,
  RuntimeSkillsSchema,
} from './runtime-profile.js';

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

describe('runtime skill companion paths', () => {
  function parseFiles(files: Record<string, string>) {
    return RuntimeSkillSchema.safeParse({ name: 'review', rawMarkdown: '# Review', files });
  }

  it.each(['./SKILL.md', './skill.md', 'a/./SKILL.md', '.', 'x/', 'a/../b.md', 'SKILL.md'])(
    'rejects companion key %j',
    key => {
      expect(parseFiles({ [key]: 'x' }).success).toBe(false);
    }
  );

  it('accepts nested companion paths', () => {
    expect(parseFiles({ 'scripts/run.sh': 'x' }).success).toBe(true);
  });

  it('rejects companion keys that differ only by case', () => {
    expect(parseFiles({ 'A.md': 'a', 'a.md': 'b' }).success).toBe(false);
    expect(parseFiles({ 'a/b.md': 'a', 'A/B.md': 'b' }).success).toBe(false);
  });

  it('keeps a key spelled like an inherited property', () => {
    const files = Object.fromEntries([['__proto__', 'keep']]);
    expect(parseFiles(files).success).toBe(true);
    expect(Object.entries(acceptedRuntimeSkillFiles(files).accepted)).toEqual([
      ['__proto__', 'keep'],
    ]);
  });
});
