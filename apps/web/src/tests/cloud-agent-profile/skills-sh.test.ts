/**
 * Integration coverage for skills.sh profile references: stored reference
 * shape, router ownership and limits, session wire output, update restrictions,
 * and merge precedence. Runs against the web Postgres test harness.
 */
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_repo_bindings,
  agent_environment_profile_skills,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import {
  createSkillsShSkill,
  getSkillsForSession,
  MAX_PROFILE_SKILLS,
  mergeProfileConfiguration,
  skillsShInputSchema,
  updateSkill,
  type ProfileOwner,
  type SkillForSession,
} from '@kilocode/cloud-agent-profile';

let ownerUser: User;
let otherUser: User;
const createdProfileIds: string[] = [];

function userOwner(userId: string): ProfileOwner {
  return { type: 'user', id: userId };
}

async function createProfile(userId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(agent_environment_profiles)
    .values({ owned_by_user_id: userId, name })
    .returning({ id: agent_environment_profiles.id });
  createdProfileIds.push(row.id);
  return row.id;
}

async function createReference(
  profileId: string,
  source: string,
  owner: ProfileOwner,
  enabled?: boolean
): Promise<string> {
  const parsed = skillsShInputSchema.parse({ source, enabled });
  const { id } = await createSkillsShSkill(db, profileId, parsed, owner);
  return id;
}

async function addCustomSkill(
  profileId: string,
  name: string,
  rawMarkdown: string,
  files: Record<string, string> = {}
): Promise<void> {
  await db.insert(agent_environment_profile_skills).values({
    profile_id: profileId,
    name,
    source_type: 'custom',
    raw_markdown: rawMarkdown,
    files,
  });
}

function sourceOf(skill: SkillForSession | undefined): string | null {
  return skill && 'source' in skill ? skill.source : null;
}

function markdownOf(skill: SkillForSession | undefined): string | null {
  return skill && 'rawMarkdown' in skill ? skill.rawMarkdown : null;
}

beforeAll(async () => {
  ownerUser = await insertTestUser({
    google_user_email: 'skills-sh-owner@example.com',
    google_user_name: 'Skills.sh Owner',
  });
  otherUser = await insertTestUser({
    google_user_email: 'skills-sh-other@example.com',
    google_user_name: 'Skills.sh Other',
  });
});

afterEach(async () => {
  if (createdProfileIds.length === 0) return;
  await db
    .delete(agent_environment_profile_skills)
    .where(inArray(agent_environment_profile_skills.profile_id, createdProfileIds));
  await db
    .delete(agent_environment_profile_repo_bindings)
    .where(inArray(agent_environment_profile_repo_bindings.profile_id, createdProfileIds));
  await db
    .delete(agent_environment_profiles)
    .where(inArray(agent_environment_profiles.id, createdProfileIds));
  createdProfileIds.length = 0;
});

describe('skills.sh references', () => {
  test('creates a canonical reference through the authenticated router', async () => {
    const caller = await createCallerForUser(ownerUser.id);
    const profileId = await createProfile(ownerUser.id, 'skills-sh-create');

    const created = await caller.agentProfiles.createSkillsShSkill({
      profileId,
      source: 'Kilo-Org/kilo.code@review-code',
      enabled: false,
    });

    const [row] = await db
      .select()
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.id, created.id));

    expect(row).toMatchObject({
      name: 'review-code',
      description: null,
      source_type: 'skills-sh',
      source_url: 'https://skills.sh/kilo-org/kilo.code/review-code',
      raw_markdown: '',
      files: {},
      enabled: false,
    });

    const profile = await caller.agentProfiles.get({ profileId });
    expect(profile.skills).toHaveLength(1);
    expect(profile.skills[0]).toMatchObject({
      sourceType: 'skills-sh',
      sourceUrl: 'https://skills.sh/kilo-org/kilo.code/review-code',
      rawMarkdown: '',
      files: {},
      enabled: false,
    });
  });

  test('returns CONFLICT when the skill slug already exists', async () => {
    const caller = await createCallerForUser(ownerUser.id);
    const profileId = await createProfile(ownerUser.id, 'skills-sh-duplicate');
    await addCustomSkill(profileId, 'deploy', '---\nname: deploy\n---\nbody');

    await expect(
      caller.agentProfiles.createSkillsShSkill({
        profileId,
        source: 'owner/repo@deploy',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: "A skill named 'deploy' already exists in this profile",
    });

    const rows = await db
      .select({ sourceType: agent_environment_profile_skills.source_type })
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.profile_id, profileId));
    expect(rows).toEqual([{ sourceType: 'custom' }]);
  });

  test('rejects creation on a profile owned by another user', async () => {
    const caller = await createCallerForUser(otherUser.id);
    const profileId = await createProfile(ownerUser.id, 'skills-sh-other-owner');

    await expect(
      caller.agentProfiles.createSkillsShSkill({
        profileId,
        source: 'owner/repo@deploy',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const rows = await db
      .select({ id: agent_environment_profile_skills.id })
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.profile_id, profileId));
    expect(rows).toHaveLength(0);
  });

  test('enforces the shared profile skill limit', async () => {
    const caller = await createCallerForUser(ownerUser.id);
    const profileId = await createProfile(ownerUser.id, 'skills-sh-limit');

    await db.insert(agent_environment_profile_skills).values(
      Array.from({ length: MAX_PROFILE_SKILLS }, (_, index) => ({
        profile_id: profileId,
        name: `skill-${index}`,
        source_type: 'custom' as const,
        raw_markdown: '',
        files: {},
      }))
    );

    await expect(
      caller.agentProfiles.createSkillsShSkill({
        profileId,
        source: 'owner/repo@deploy',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const rows = await db
      .select({ id: agent_environment_profile_skills.id })
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.profile_id, profileId));
    expect(rows).toHaveLength(MAX_PROFILE_SKILLS);
  });

  test('session wire emits owner/repo references and filters disabled skills', async () => {
    const profileId = await createProfile(ownerUser.id, 'skills-sh-session');
    await createReference(profileId, 'owner/repo@alpha', userOwner(ownerUser.id), false);
    await createReference(profileId, 'owner/repo@beta', userOwner(ownerUser.id));
    await addCustomSkill(profileId, 'custom-one', '---\nname: custom-one\n---\nbody', {
      'notes.md': 'notes',
    });

    const skills = await getSkillsForSession(db, profileId);

    expect(skills).toEqual([
      { name: 'beta', source: 'owner/repo' },
      {
        name: 'custom-one',
        rawMarkdown: '---\nname: custom-one\n---\nbody',
        files: { 'notes.md': 'notes' },
      },
    ]);
  });

  test('session wire rejects a reference whose stored name does not match its source slug', async () => {
    const profileId = await createProfile(ownerUser.id, 'skills-sh-name-mismatch');
    await db.insert(agent_environment_profile_skills).values({
      profile_id: profileId,
      name: 'other-name',
      source_type: 'skills-sh',
      source_url: 'https://skills.sh/owner/repo/deploy',
      raw_markdown: '',
      files: {},
    });

    await expect(getSkillsForSession(db, profileId)).rejects.toThrow(/does not match/);
  });

  test('allows enabled updates but rejects content, name, and file changes', async () => {
    const profileId = await createProfile(ownerUser.id, 'skills-sh-update');
    const owner = userOwner(ownerUser.id);
    const skillId = await createReference(profileId, 'owner/repo@deploy', owner);

    await updateSkill(db, profileId, skillId, { enabled: false }, owner);

    for (const input of [
      { name: 'renamed' },
      { rawMarkdown: '---\nname: renamed\n---\nbody' },
      { files: { 'helper.sh': 'echo hi' } },
    ]) {
      await expect(updateSkill(db, profileId, skillId, input, owner)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }

    const [row] = await db
      .select()
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.id, skillId));
    expect(row).toMatchObject({
      name: 'deploy',
      source_type: 'skills-sh',
      source_url: 'https://skills.sh/owner/repo/deploy',
      raw_markdown: '',
      files: {},
      enabled: false,
    });
  });

  test('merges references and bundles with profile and inline precedence', async () => {
    const owner = userOwner(ownerUser.id);
    const baseProfileId = await createProfile(ownerUser.id, 'skills-sh-base');
    const overrideProfileId = await createProfile(ownerUser.id, 'skills-sh-override');

    await addCustomSkill(baseProfileId, 'alpha', '---\nname: alpha\n---\nbase bundle');
    await createReference(baseProfileId, 'owner/repo@beta', owner);
    await createReference(baseProfileId, 'owner/repo@gamma', owner);
    await db.insert(agent_environment_profile_repo_bindings).values({
      profile_id: baseProfileId,
      repo_full_name: 'org/repo',
      platform: 'github',
      owned_by_user_id: ownerUser.id,
    });

    await createReference(overrideProfileId, 'owner/repo@alpha', owner);
    await addCustomSkill(overrideProfileId, 'beta', '---\nname: beta\n---\noverride bundle');

    const result = await mergeProfileConfiguration(db, {
      owner,
      profileId: overrideProfileId,
      repoFullName: 'org/repo',
      platform: 'github',
      runtimeSkills: [{ name: 'gamma', rawMarkdown: 'inline gamma' }],
    });

    const byName = new Map<string, SkillForSession>(
      (result.skills ?? []).map(skill => [skill.name, skill] as const)
    );
    expect([...byName.keys()].sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(sourceOf(byName.get('alpha'))).toBe('owner/repo');
    expect(markdownOf(byName.get('beta'))).toContain('override bundle');
    expect(markdownOf(byName.get('gamma'))).toBe('inline gamma');
  });

  test('custom skills remain editable after a reference exists', async () => {
    const profileId = await createProfile(ownerUser.id, 'skills-sh-custom-update');
    const owner = userOwner(ownerUser.id);
    await createReference(profileId, 'owner/repo@deploy', owner);

    const [custom] = await db
      .insert(agent_environment_profile_skills)
      .values({
        profile_id: profileId,
        name: 'local-skill',
        source_type: 'custom',
        raw_markdown: '---\nname: local-skill\n---\nbody',
        files: {},
      })
      .returning({ id: agent_environment_profile_skills.id });

    await updateSkill(db, profileId, custom.id, { name: 'renamed-skill' }, owner);

    const [row] = await db
      .select({ name: agent_environment_profile_skills.name })
      .from(agent_environment_profile_skills)
      .where(
        and(
          eq(agent_environment_profile_skills.profile_id, profileId),
          eq(agent_environment_profile_skills.id, custom.id)
        )
      );
    expect(row.name).toBe('renamed-skill');
  });
});
