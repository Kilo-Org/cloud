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

  test('ignores long non-matching frontmatter lines', () => {
    expect(
      parseSkillFrontmatter(`---\n${'x'.repeat(100_000)}\ndescription: Ready\n---\nBody`)
    ).toEqual({
      name: null,
      description: 'Ready',
    });
  });
});
