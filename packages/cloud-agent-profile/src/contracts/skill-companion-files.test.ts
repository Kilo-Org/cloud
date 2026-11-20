import { describe, expect, test } from 'vitest';
import { acceptedSkillCompanionFiles } from './skill-companion-files';
import { skillFilesSchema } from './skills';

function firstIssue(files: Record<string, string>): string | undefined {
  const result = skillFilesSchema.safeParse(files);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('skillFilesSchema companion-file paths', () => {
  test.each([
    ['./SKILL.md', 'Skill file path rejected: ./SKILL.md'],
    ['./skill.md', 'Skill file path rejected: ./skill.md'],
    ['a/./SKILL.md', 'Skill file path rejected: a/./SKILL.md'],
    ['.', 'Skill file path rejected: .'],
    ['x/', 'Skill file path rejected: x/'],
    ['/x', 'Skill file path rejected: /x'],
    ['a/../b.md', 'Skill file path rejected: a/../b.md'],
    ['SKILL.md', 'SKILL.md must be supplied as rawMarkdown, not in files'],
    ['skill.md', 'SKILL.md must be supplied as rawMarkdown, not in files'],
  ])('rejects %j', (path, message) => {
    expect(firstIssue({ [path]: 'x' })).toBe(message);
  });

  test.each(['notes.md', 'scripts/run.sh', 'a/b/c.md', 'x'])('accepts %j', path => {
    expect(skillFilesSchema.safeParse({ [path]: 'x' }).success).toBe(true);
  });

  test.each([
    [{ x: 'a', './x': 'b' }, 'Skill file path rejected: ./x'],
    [{ 'A.md': 'a', 'a.md': 'b' }, 'Skill file path duplicates another companion file: a.md'],
    [{ 'a/b.md': 'a', 'A/B.md': 'b' }, 'Skill file path duplicates another companion file: A/B.md'],
  ])('rejects duplicate companion files %j', (files, message) => {
    expect(firstIssue(files)).toBe(message);
  });
});

describe('acceptedSkillCompanionFiles', () => {
  test('keeps accepted rows and drops rejected ones', () => {
    expect(acceptedSkillCompanionFiles({ x: 'keep', './x': 'drop', 'SKILL.md': 'drop' })).toEqual({
      x: 'keep',
    });
  });

  test('keeps the first spelling of a case-folded duplicate', () => {
    expect(acceptedSkillCompanionFiles({ 'A.md': 'first', 'a.md': 'second' })).toEqual({
      'A.md': 'first',
    });
  });

  test('keeps a key spelled like an inherited property', () => {
    const accepted = acceptedSkillCompanionFiles(Object.fromEntries([['__proto__', 'keep']]));
    expect(Object.entries(accepted)).toEqual([['__proto__', 'keep']]);
  });
});
