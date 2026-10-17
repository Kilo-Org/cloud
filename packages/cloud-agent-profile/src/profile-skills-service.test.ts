import { describe, expect, test } from 'vitest';
import {
  parseSkillFrontmatter,
  MAX_PROFILE_SKILLS,
  createCustomSkill,
  type SkillCustomInput,
} from './profile-skills-service';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };

function skillInput(name: string): SkillCustomInput {
  return { name, rawMarkdown: `# ${name}` };
}

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

describe('createCustomSkill cap enforcement', () => {
  test('stores a skill while the profile is below the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_SKILLS - 1);

    await expect(
      createCustomSkill(db, TEST_PROFILE_ID, skillInput('deploy'), OWNER)
    ).resolves.toEqual({ id: expect.any(String) });
    expect(state.rowCount).toBe(MAX_PROFILE_SKILLS);
    expect(state.lockCalls).toBe(1);
  });

  test('rejects a create at the cap without inserting', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_SKILLS);

    await expect(
      createCustomSkill(db, TEST_PROFILE_ID, skillInput('deploy'), OWNER)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(state.rowCount).toBe(MAX_PROFILE_SKILLS);
    expect(state.lockCalls).toBe(1);
  });

  test('keeps concurrent creates within the per-profile cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_SKILLS - 1);

    const results = await Promise.allSettled([
      createCustomSkill(db, TEST_PROFILE_ID, skillInput('first'), OWNER),
      createCustomSkill(db, TEST_PROFILE_ID, skillInput('second'), OWNER),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(state.rowCount).toBe(MAX_PROFILE_SKILLS);
    expect(state.lockCalls).toBe(2);
  });
});
