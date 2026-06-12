import { describe, expect, test } from 'vitest';
import { parseSkillFrontmatter } from './profile-skills-service';

describe('parseSkillFrontmatter', () => {
  test('extracts name and description from YAML frontmatter', () => {
    expect(
      parseSkillFrontmatter('---\nname: deploy\ndescription: "Deploy services"\n---\nBody')
    ).toEqual({
      name: 'deploy',
      description: 'Deploy services',
    });
  });

  test('accepts delimiter lines with trailing horizontal whitespace', () => {
    expect(parseSkillFrontmatter('--- \t\nname: deploy\n--- \t\nBody')).toEqual({
      name: 'deploy',
      description: null,
    });
  });

  test('ignores long non-matching frontmatter lines', () => {
    expect(
      parseSkillFrontmatter(`---\n${'x'.repeat(100_000)}\ndescription: Ready\n---\nBody`)
    ).toEqual({
      name: null,
      description: 'Ready',
    });
  });

  test('returns null values for unterminated frontmatter-like input', () => {
    expect(parseSkillFrontmatter(`---\n${'\n\t'.repeat(50_000)}`)).toEqual({
      name: null,
      description: null,
    });
  });
});
