/**
 * Integration tests for config import preview and selective upsert apply against
 * the real web Postgres test harness: row-lock serialization and the
 * read-only repeatable-read resolution snapshot cannot be faked.
 */
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db, pool } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  agent_environment_profile_agents,
  agent_environment_profile_kilo_commands,
  agent_environment_profile_instructions,
  kilocode_users,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  applyImport,
  buildImportPreview,
  mergeProfileConfiguration,
  type ProfileOwner,
} from '@kilocode/cloud-agent-profile';
import {
  MAX_IMPORT_ARCHIVE_ENTRIES,
  MAX_IMPORT_ENCODED_LENGTH,
  MAX_IMPORT_ZIP_BYTES,
  parseLocalConfigArchive,
  type ImportSelection,
  type ParsedLocalConfig,
} from '@kilocode/cloud-agent-profile/import';
import { buildZip } from '@kilocode/cloud-agent-profile/import/testing';
import type { PoolClient } from 'pg';
import type { User } from '@kilocode/db/schema';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function userOwner(userId: string): ProfileOwner {
  return { type: 'user', id: userId };
}

function encodeArchive(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function createProfile(userId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(agent_environment_profiles)
    .values({ owned_by_user_id: userId, name })
    .returning({ id: agent_environment_profiles.id });
  return row.id;
}

async function seedAgent(
  profileId: string,
  slug: string,
  config: Record<string, unknown>
): Promise<void> {
  await db
    .insert(agent_environment_profile_agents)
    .values({ profile_id: profileId, slug, name: slug, config });
}

async function seedCommand(
  profileId: string,
  name: string,
  template: string,
  extra: Partial<{ description: string; agent: string; model: string; subtask: boolean }> = {}
): Promise<void> {
  await db.insert(agent_environment_profile_kilo_commands).values({
    profile_id: profileId,
    name,
    template,
    description: extra.description ?? null,
    agent: extra.agent ?? null,
    model: extra.model ?? null,
    subtask: extra.subtask ?? false,
  });
}

async function seedSkill(profileId: string, name: string, rawMarkdown: string): Promise<void> {
  await db.insert(agent_environment_profile_skills).values({
    profile_id: profileId,
    name,
    source_type: 'custom',
    raw_markdown: rawMarkdown,
    files: {},
  });
}

async function seedInstruction(profileId: string, name: string, content: string): Promise<void> {
  await db
    .insert(agent_environment_profile_instructions)
    .values({ profile_id: profileId, name, content });
}

function selectionOf(partial: Partial<ImportSelection>): ImportSelection {
  return { agents: [], commands: [], skills: [], instructions: [], ...partial };
}

function makeAgents(prefix: string, count: number): ParsedLocalConfig {
  return {
    agents: Array.from({ length: count }, (_, index) => ({
      slug: `${prefix}-agent-${index}`,
      name: `${prefix} agent ${index}`,
      config: { prompt: `prompt ${index}` },
    })),
    commands: [],
    skills: [],
    instructions: [],
  };
}

function makeSnapshot(prefix: string): ParsedLocalConfig {
  const tag = prefix.toLowerCase();
  return {
    agents: [
      { slug: `agent-${tag}-1`, name: `Agent ${tag} 1`, config: { prompt: `prompt-${tag}-1` } },
      { slug: `agent-${tag}-2`, name: `Agent ${tag} 2`, config: { prompt: `prompt-${tag}-2` } },
    ],
    commands: [{ name: `command-${tag}`, template: `template-${tag}`, subtask: false }],
    skills: [
      {
        name: `skill-${tag}`,
        rawMarkdown: `---\nname: skill-${tag}\n---\n${tag}`,
        files: {},
      },
    ],
    instructions: [{ name: `instruction-${tag}`, content: `content-${tag}` }],
  };
}

async function readSnapshotState(profileId: string) {
  const [agents, commands, skills, instructions] = await Promise.all([
    db
      .select({ slug: agent_environment_profile_agents.slug })
      .from(agent_environment_profile_agents)
      .where(eq(agent_environment_profile_agents.profile_id, profileId)),
    db
      .select({ name: agent_environment_profile_kilo_commands.name })
      .from(agent_environment_profile_kilo_commands)
      .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId)),
    db
      .select({ name: agent_environment_profile_skills.name })
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.profile_id, profileId)),
    db
      .select({ name: agent_environment_profile_instructions.name })
      .from(agent_environment_profile_instructions)
      .where(eq(agent_environment_profile_instructions.profile_id, profileId)),
  ]);
  return {
    agents: agents.map(row => row.slug).sort(),
    commands: commands.map(row => row.name).sort(),
    skills: skills.map(row => row.name).sort(),
    instructions: instructions.map(row => row.name).sort(),
  };
}

/**
 * Poll `pg_locks` until `expected` other backends of this test connection are
 * blocked on a lock. Observing the lock waits proves the operations actually
 * overlapped instead of assuming it from a fixed sleep.
 */
async function waitForBlockedLockWaiters(client: PoolClient, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(DISTINCT locked.pid)::int AS n
         FROM pg_locks locked
         JOIN pg_stat_activity activity ON activity.pid = locked.pid
        WHERE NOT locked.granted
          AND activity.datname = current_database()
          AND activity.application_name = current_setting('application_name')
          AND locked.pid <> pg_backend_pid()`
    );
    if (rows[0].n >= expected) return;
    if (Date.now() > deadline) {
      const diagnostics = await client.query<{ wait: string | null; query: string }>(
        `SELECT wait_event_type || ':' || coalesce(wait_event, '') AS wait, query
           FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`
      );
      throw new Error(
        `timed out waiting for ${expected} lock waiters; activity: ${JSON.stringify(diagnostics.rows)}`
      );
    }
    await sleep(20);
  }
}

/** Release a held test transaction even when an assertion failed mid-test. */
async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Already committed or rolled back; nothing left to release.
  }
}

async function readFullProfileContents(profileId: string) {
  const [agents, commands, skills, instructions] = await Promise.all([
    db
      .select()
      .from(agent_environment_profile_agents)
      .where(eq(agent_environment_profile_agents.profile_id, profileId))
      .orderBy(agent_environment_profile_agents.slug),
    db
      .select()
      .from(agent_environment_profile_kilo_commands)
      .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId))
      .orderBy(agent_environment_profile_kilo_commands.name),
    db
      .select()
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.profile_id, profileId))
      .orderBy(agent_environment_profile_skills.name),
    db
      .select()
      .from(agent_environment_profile_instructions)
      .where(eq(agent_environment_profile_instructions.profile_id, profileId))
      .orderBy(agent_environment_profile_instructions.name),
  ]);
  return { agents, commands, skills, instructions };
}

async function readRowIdsByIdentity(profileId: string): Promise<Map<string, string>> {
  const [agents, commands, skills, instructions] = await Promise.all([
    db
      .select({
        id: agent_environment_profile_agents.id,
        slug: agent_environment_profile_agents.slug,
      })
      .from(agent_environment_profile_agents)
      .where(eq(agent_environment_profile_agents.profile_id, profileId)),
    db
      .select({
        id: agent_environment_profile_kilo_commands.id,
        name: agent_environment_profile_kilo_commands.name,
      })
      .from(agent_environment_profile_kilo_commands)
      .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId)),
    db
      .select({
        id: agent_environment_profile_skills.id,
        name: agent_environment_profile_skills.name,
      })
      .from(agent_environment_profile_skills)
      .where(eq(agent_environment_profile_skills.profile_id, profileId)),
    db
      .select({
        id: agent_environment_profile_instructions.id,
        name: agent_environment_profile_instructions.name,
      })
      .from(agent_environment_profile_instructions)
      .where(eq(agent_environment_profile_instructions.profile_id, profileId)),
  ]);
  const ids = new Map<string, string>();
  for (const row of agents) ids.set(`agent:${row.slug}`, row.id);
  for (const row of commands) ids.set(`command:${row.name}`, row.id);
  for (const row of skills) ids.set(`skill:${row.name}`, row.id);
  for (const row of instructions) ids.set(`instruction:${row.name}`, row.id);
  return ids;
}

async function readActivationState(profileId: string) {
  const [commands, skills, instructions] = await Promise.all([
    db
      .select({
        enabled: agent_environment_profile_kilo_commands.enabled,
        sortOrder: agent_environment_profile_kilo_commands.sort_order,
      })
      .from(agent_environment_profile_kilo_commands)
      .where(
        and(
          eq(agent_environment_profile_kilo_commands.profile_id, profileId),
          eq(agent_environment_profile_kilo_commands.name, 'sync')
        )
      ),
    db
      .select({
        enabled: agent_environment_profile_skills.enabled,
        sourceType: agent_environment_profile_skills.source_type,
        sourceUrl: agent_environment_profile_skills.source_url,
      })
      .from(agent_environment_profile_skills)
      .where(
        and(
          eq(agent_environment_profile_skills.profile_id, profileId),
          eq(agent_environment_profile_skills.name, 'deploy')
        )
      ),
    db
      .select({ enabled: agent_environment_profile_instructions.enabled })
      .from(agent_environment_profile_instructions)
      .where(
        and(
          eq(agent_environment_profile_instructions.profile_id, profileId),
          eq(agent_environment_profile_instructions.name, 'style')
        )
      ),
  ]);
  return { command: commands[0], skill: skills[0], instruction: instructions[0] };
}

async function deleteProfilesForUser(userId: string): Promise<void> {
  await db
    .delete(agent_environment_profiles)
    .where(eq(agent_environment_profiles.owned_by_user_id, userId));
}

describe('Profile config import', () => {
  let owner: User;
  let otherUser: User;

  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'profile-import-owner@example.com',
      google_user_name: 'Profile Import Owner',
    });
    otherUser = await insertTestUser({
      google_user_email: 'profile-import-other@example.com',
      google_user_name: 'Profile Import Other',
    });
  });

  afterEach(async () => {
    await deleteProfilesForUser(owner.id);
    await deleteProfilesForUser(otherUser.id);
  });

  describe('buildImportPreview', () => {
    test('lists new and changed definitions, omits unchanged and cloud-only rows, and writes nothing', async () => {
      const profileId = await createProfile(owner.id, 'Preview Profile');
      await seedAgent(profileId, 'reviewer', { description: 'Reviews', prompt: 'old prompt' });
      await seedAgent(profileId, 'legacy', { prompt: 'legacy' });
      await seedCommand(profileId, 'fix', 'Fix old');
      await seedSkill(profileId, 'deploy', '---\nname: deploy\n---\nDeploy');
      await seedInstruction(profileId, 'style', 'old style');

      const archive = buildZip({
        'cfg/agent/reviewer.md': '---\ndescription: Reviews\n---\nnew prompt',
        'cfg/agent/dupe.md': 'One',
        'cfg/agents/dupe.md': 'Two',
        'cfg/command/fix.md': '---\n---\nFix new',
        'cfg/command/newcmd.md': '---\ndescription: New command\n---\nDo new',
        'cfg/instructions/style.md': 'old style',
      });

      const parsed = parseLocalConfigArchive(archive);
      const preview = await buildImportPreview(db, profileId, parsed, userOwner(owner.id));

      expect(preview.issues).toEqual([
        expect.objectContaining({ code: 'duplicate-definition', category: 'agents' }),
      ]);
      expect(preview.agents.added).toEqual([]);
      expect(preview.agents.changed.map(item => item.id)).toEqual(['reviewer']);
      expect(preview.agents.changed[0].changes).toContainEqual({
        field: 'config.prompt',
        before: 'old prompt',
        after: 'new prompt',
      });

      expect(preview.commands.added.map(item => item.id)).toEqual(['newcmd']);
      expect(preview.commands.changed.map(item => item.id)).toEqual(['fix']);
      expect(preview.commands.changed[0].changes).toEqual([
        { field: 'template', before: 'Fix old', after: 'Fix new' },
      ]);

      // Unchanged and cloud-only definitions are not offered.
      expect(preview.skills).toEqual({ added: [], changed: [] });
      expect(preview.instructions).toEqual({ added: [], changed: [] });

      const state = await readSnapshotState(profileId);
      expect(state.agents).toEqual(['legacy', 'reviewer']);
      expect(state.commands).toEqual(['fix']);
      expect(state.skills).toEqual(['deploy']);
      expect(state.instructions).toEqual(['style']);
    });

    test('reports activation and overwritten metadata for otherwise identical definitions', async () => {
      const profileId = await createProfile(owner.id, 'Activation Preview Profile');
      await db.insert(agent_environment_profile_kilo_commands).values({
        profile_id: profileId,
        name: 'sync',
        template: 'Sync it',
        enabled: false,
        sort_order: 7,
      });
      await db.insert(agent_environment_profile_skills).values({
        profile_id: profileId,
        name: 'deploy',
        source_type: 'marketplace',
        source_url: 'https://skills.example.com/deploy',
        raw_markdown: '---\nname: deploy\n---\nDeploy it',
        files: {},
        enabled: false,
      });
      await db.insert(agent_environment_profile_instructions).values({
        profile_id: profileId,
        name: 'style',
        content: 'Prefer small functions.',
        enabled: false,
      });

      const archive = buildZip({
        'cfg/command/sync.md': '---\n---\nSync it',
        'cfg/skills/deploy/SKILL.md': '---\nname: deploy\n---\nDeploy it',
        'cfg/instructions/style.md': 'Prefer small functions.',
      });
      const parsed = parseLocalConfigArchive(archive);
      expect(parsed.issues).toEqual([]);

      const preview = await buildImportPreview(db, profileId, parsed, userOwner(owner.id));

      // Import keeps an existing command's position, so order is not a change.
      const commandChange = preview.commands.changed.find(item => item.id === 'sync');
      expect(commandChange?.changes).toEqual([{ field: 'enabled', before: false, after: true }]);

      const skillChange = preview.skills.changed.find(item => item.id === 'deploy');
      expect(skillChange?.changes).toContainEqual({ field: 'enabled', before: false, after: true });
      expect(skillChange?.changes).toContainEqual({
        field: 'sourceType',
        before: 'marketplace',
        after: 'custom',
      });
      expect(skillChange?.changes).toContainEqual({
        field: 'sourceUrl',
        before: 'https://skills.example.com/deploy',
        after: null,
      });

      const instructionChange = preview.instructions.changed.find(item => item.id === 'style');
      expect(instructionChange?.changes).toContainEqual({
        field: 'enabled',
        before: false,
        after: true,
      });

      const beforeApply = await readActivationState(profileId);
      expect(beforeApply.command.enabled).toBe(false);
      expect(beforeApply.skill.enabled).toBe(false);
      expect(beforeApply.instruction.enabled).toBe(false);
    });
  });

  describe('applyImport', () => {
    test('upserts the given definitions and leaves other rows, vars, setup, and MCP untouched', async () => {
      const profileId = await createProfile(owner.id, 'Apply Profile');
      await seedAgent(profileId, 'old-agent', { prompt: 'old' });
      await seedCommand(profileId, 'old-command', 'old template');
      await seedSkill(profileId, 'old-skill', '---\nname: old-skill\n---\nold');
      await seedInstruction(profileId, 'old-instruction', 'old');
      await db
        .insert(agent_environment_profile_vars)
        .values({ profile_id: profileId, key: 'KEEP_VAR', value: 'keep', is_secret: false });
      await db
        .insert(agent_environment_profile_commands)
        .values({ profile_id: profileId, sequence: 0, command: 'keep-setup' });
      await db.insert(agent_environment_profile_mcp_servers).values({
        profile_id: profileId,
        name: 'keep-mcp',
        type: 'local',
        config: { command: ['npx', 'keep'] },
      });

      const parsed = makeSnapshot('new');
      await applyImport(db, profileId, parsed, userOwner(owner.id));

      const state = await readSnapshotState(profileId);
      expect(state.agents).toEqual(['agent-new-1', 'agent-new-2', 'old-agent']);
      expect(state.commands).toEqual(['command-new', 'old-command']);
      expect(state.skills).toEqual(['old-skill', 'skill-new']);
      expect(state.instructions).toEqual(['instruction-new', 'old-instruction']);

      const vars = await db
        .select({ key: agent_environment_profile_vars.key })
        .from(agent_environment_profile_vars)
        .where(eq(agent_environment_profile_vars.profile_id, profileId));
      expect(vars.map(row => row.key)).toEqual(['KEEP_VAR']);

      const setup = await db
        .select({ command: agent_environment_profile_commands.command })
        .from(agent_environment_profile_commands)
        .where(eq(agent_environment_profile_commands.profile_id, profileId));
      expect(setup.map(row => row.command)).toEqual(['keep-setup']);

      const mcp = await db
        .select({ name: agent_environment_profile_mcp_servers.name })
        .from(agent_environment_profile_mcp_servers)
        .where(eq(agent_environment_profile_mcp_servers.profile_id, profileId));
      expect(mcp.map(row => row.name)).toEqual(['keep-mcp']);
    });

    test('re-import updates definitions in place and keeps definitions it does not include', async () => {
      const profileId = await createProfile(owner.id, 'Re-import Profile');
      const ownerRef = userOwner(owner.id);
      const first = makeSnapshot('A');
      await applyImport(db, profileId, first, ownerRef);

      const idsAfterFirst = await readRowIdsByIdentity(profileId);
      expect(idsAfterFirst.size).toBe(5);

      const second: ParsedLocalConfig = {
        agents: [{ ...first.agents[0], config: { prompt: 'updated prompt' } }],
        commands: [],
        skills: [],
        instructions: [],
      };
      await applyImport(db, profileId, second, ownerRef);

      const idsAfterSecond = await readRowIdsByIdentity(profileId);
      expect(idsAfterSecond).toEqual(idsAfterFirst);

      const [updated] = await db
        .select({ config: agent_environment_profile_agents.config })
        .from(agent_environment_profile_agents)
        .where(
          and(
            eq(agent_environment_profile_agents.profile_id, profileId),
            eq(agent_environment_profile_agents.slug, 'agent-a-1')
          )
        );
      expect(updated.config).toEqual({ prompt: 'updated prompt' });
    });

    test('appends new commands after existing ones and keeps existing positions', async () => {
      const profileId = await createProfile(owner.id, 'Command Order Profile');
      await db.insert(agent_environment_profile_kilo_commands).values([
        { profile_id: profileId, name: 'first', template: 'First', sort_order: 0 },
        { profile_id: profileId, name: 'second', template: 'Second', sort_order: 1 },
      ]);

      await applyImport(
        db,
        profileId,
        {
          agents: [],
          commands: [
            { name: 'second', template: 'Second updated' },
            { name: 'third', template: 'Third' },
          ],
          skills: [],
          instructions: [],
        },
        userOwner(owner.id)
      );

      const rows = await db
        .select({
          name: agent_environment_profile_kilo_commands.name,
          sortOrder: agent_environment_profile_kilo_commands.sort_order,
        })
        .from(agent_environment_profile_kilo_commands)
        .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId))
        .orderBy(agent_environment_profile_kilo_commands.sort_order);
      expect(rows.map(row => row.name)).toEqual(['first', 'second', 'third']);
      expect(rows[1].sortOrder).toBe(1);
    });

    test('rolls back earlier category writes when a later category write fails', async () => {
      const profileId = await createProfile(owner.id, 'Rollback Profile');
      await seedAgent(profileId, 'keep-agent', { prompt: 'keep' });
      await seedCommand(profileId, 'keep-command', 'keep template');
      await seedSkill(profileId, 'keep-skill', '---\nname: keep-skill\n---\nkeep');
      await seedInstruction(profileId, 'keep-instruction', 'keep');
      const before = await readFullProfileContents(profileId);

      const parsed: ParsedLocalConfig = {
        agents: [{ slug: 'new-agent', name: 'New Agent', config: { prompt: 'new' } }],
        commands: [{ name: 'new-command', template: 'new template' }],
        skills: [{ name: 'new-skill', rawMarkdown: '---\nname: new-skill\n---\nnew', files: {} }],
        // Duplicate identities make the final insert violate the
        // (profile_id, name) unique key, so the database rejects the write
        // after agents, commands, and skills have already been replaced in the
        // same transaction.
        instructions: [
          { name: 'dup-instruction', content: 'first' },
          { name: 'dup-instruction', content: 'second' },
        ],
      };

      await expect(applyImport(db, profileId, parsed, userOwner(owner.id))).rejects.toThrow();

      const after = await readFullProfileContents(profileId);
      expect(after).toEqual(before);
    });

    test('rejects an over-cap import and rolls back with existing rows intact', async () => {
      const profileId = await createProfile(owner.id, 'Cap Profile');
      await seedAgent(profileId, 'keep-agent', { prompt: 'keep' });

      const oversized: ParsedLocalConfig = {
        agents: Array.from({ length: 21 }, (_, index) => ({
          slug: `cap-agent-${index}`,
          name: `Cap Agent ${index}`,
          config: { prompt: `prompt ${index}` },
        })),
        commands: [],
        skills: [],
        instructions: [],
      };

      await expect(applyImport(db, profileId, oversized, userOwner(owner.id))).rejects.toThrow(
        /would leave 22 agents on this profile, over the 20 agents limit/
      );

      const state = await readSnapshotState(profileId);
      expect(state.agents).toEqual(['keep-agent']);
    });

    test('counts stored rows against the cap but not definitions it updates', async () => {
      const profileId = await createProfile(owner.id, 'Stored Cap Profile');
      const ownerRef = userOwner(owner.id);
      await applyImport(db, profileId, makeAgents('stored', 19), ownerRef);

      await expect(applyImport(db, profileId, makeAgents('extra', 2), ownerRef)).rejects.toThrow(
        /would leave 21 agents/
      );

      const atCap: ParsedLocalConfig = {
        ...makeAgents('extra', 1),
        agents: [
          ...makeAgents('extra', 1).agents,
          { slug: 'stored-agent-0', name: 'stored agent 0', config: { prompt: 'updated' } },
        ],
      };
      await applyImport(db, profileId, atCap, ownerRef);

      const state = await readSnapshotState(profileId);
      expect(state.agents).toHaveLength(20);
    });

    test('rejects a selected definition that violates the runtime contract', async () => {
      const profileId = await createProfile(owner.id, 'Runtime Contract Profile');
      await seedAgent(profileId, 'keep-agent', { prompt: 'keep' });

      const archive = buildZip({
        'command/long-model.md': `---\nmodel: ${'m'.repeat(201)}\n---\nbody`,
        'command/valid.md': 'Valid body',
      });
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.agentProfiles.applyConfigImport({
          profileId,
          archive: encodeArchive(archive),
          selection: selectionOf({ commands: ['valid', 'long-model'] }),
        })
      ).rejects.toThrow(/Selected command "long-model" cannot be imported from this archive/);

      const state = await readSnapshotState(profileId);
      expect(state.agents).toEqual(['keep-agent']);
      expect(state.commands).toEqual([]);
    });

    test('imports only the selected definitions through the procedure', async () => {
      const profileId = await createProfile(owner.id, 'Procedure Apply Profile');
      const archive = buildZip({
        'cfg/kilo.jsonc': JSON.stringify({ agent: { plan: { disable: true } } }),
        'cfg/agent/reviewer.md': '---\ndescription: Reviews\n---\nReview it.',
        'cfg/agent/skipped.md': 'Not selected.',
        'cfg/command/skipped.md': 'Not selected.',
        'cfg/instructions/style.md': 'Prefer small functions.',
      });
      const caller = await createCallerForUser(owner.id);

      const result = await caller.agentProfiles.applyConfigImport({
        profileId,
        archive: encodeArchive(archive),
        selection: selectionOf({ agents: ['reviewer'], instructions: ['style'] }),
      });
      expect(result).toEqual({ success: true });

      const state = await readSnapshotState(profileId);
      expect(state.agents).toEqual(['reviewer']);
      expect(state.commands).toEqual([]);
      expect(state.instructions).toEqual(['style']);
    });

    test('rejects an empty selection', async () => {
      const profileId = await createProfile(owner.id, 'Empty Selection Profile');
      const archive = buildZip({ 'cfg/agent/reviewer.md': 'Review.' });
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.agentProfiles.applyConfigImport({
          profileId,
          archive: encodeArchive(archive),
          selection: selectionOf({}),
        })
      ).rejects.toThrow(/Select at least one definition/);
    });

    test('denies a non-member without changing the org profile', async () => {
      const org = await createTestOrganization('Import Org', owner.id, 100000);
      await addUserToOrganization(org.id, otherUser.id, 'member');
      const outsider = await insertTestUser({
        google_user_email: 'profile-import-outsider@example.com',
        google_user_name: 'Profile Import Outsider',
      });
      try {
        const [row] = await db
          .insert(agent_environment_profiles)
          .values({ owned_by_organization_id: org.id, name: 'Org Import Profile' })
          .returning({ id: agent_environment_profiles.id });
        const profileId = row.id;
        await seedAgent(profileId, 'org-agent', { prompt: 'org' });

        const archive = buildZip({ 'cfg/agent/reviewer.md': '---\n---\nReview.' });
        const caller = await createCallerForUser(outsider.id);

        await expect(
          caller.agentProfiles.applyConfigImport({
            organizationId: org.id,
            profileId,
            archive: encodeArchive(archive),
            selection: selectionOf({ agents: ['reviewer'] }),
          })
        ).rejects.toThrow('You do not have access to this organization');

        const state = await readSnapshotState(profileId);
        expect(state.agents).toEqual(['org-agent']);
      } finally {
        await db
          .delete(agent_environment_profiles)
          .where(eq(agent_environment_profiles.owned_by_organization_id, org.id));
        await db.delete(kilocode_users).where(eq(kilocode_users.id, outsider.id));
      }
    });

    test('serializes overlapping imports so together they cannot exceed the cap', async () => {
      const profileId = await createProfile(owner.id, 'Concurrent Import Profile');
      const ownerRef = userOwner(owner.id);

      const lockClient = await pool.connect();
      let results: PromiseSettledResult<void>[];
      try {
        await lockClient.query('BEGIN');
        await lockClient.query(
          'SELECT id FROM agent_environment_profiles WHERE id = $1 FOR UPDATE',
          [profileId]
        );

        // Each import fits the cap alone; both together would not.
        const both = Promise.allSettled([
          applyImport(db, profileId, makeAgents('a', 12), ownerRef),
          applyImport(db, profileId, makeAgents('b', 12), ownerRef),
        ]);

        // Both applies must be observed waiting on the parent-row lock before
        // the lock is released, so the test proves overlap rather than assuming
        // both calls reached the lock within a fixed sleep.
        await waitForBlockedLockWaiters(lockClient, 2);

        await lockClient.query('COMMIT');
        results = await both;
      } finally {
        await rollbackQuietly(lockClient);
        lockClient.release();
      }

      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find(result => result.status === 'rejected');
      expect(String(rejected?.reason)).toMatch(/would leave 24 agents/);

      const state = await readSnapshotState(profileId);
      expect(state.agents).toHaveLength(12);
      const prefixes = new Set(state.agents.map(slug => slug.split('-')[0]));
      expect(prefixes.size).toBe(1);
    }, 30000);
  });

  describe('mergeProfileConfiguration snapshot', () => {
    test('reads one complete bundle when an import commits mid-resolution', async () => {
      const profileId = await createProfile(owner.id, 'Snapshot Resolution Profile');
      await seedAgent(profileId, 'agent-a-1', { prompt: 'a1' });
      await seedAgent(profileId, 'agent-a-2', { prompt: 'a2' });
      await seedCommand(profileId, 'command-a', 'template-a');
      await seedSkill(profileId, 'skill-a', '---\nname: skill-a\n---\na');
      await seedInstruction(profileId, 'instruction-a', 'content-a');

      const ownerRef = userOwner(owner.id);
      const lockClient = await pool.connect();
      try {
        await lockClient.query('BEGIN');
        // ACCESS EXCLUSIVE blocks plain SELECTs on this table. Resolution
        // reads mcp servers third, after vars and setup commands, so its
        // repeatable-read snapshot is established before the import commits.
        await lockClient.query(
          'LOCK TABLE agent_environment_profile_mcp_servers IN ACCESS EXCLUSIVE MODE'
        );

        const resolution = mergeProfileConfiguration(db, { profileId, owner: ownerRef });

        // Observing resolution blocked on the MCP table proves its earlier
        // reads already ran, so its repeatable-read snapshot predates the apply
        // that commits below and it must return the complete old bundle.
        await waitForBlockedLockWaiters(lockClient, 1);

        // Apply commits while resolution is blocked mid-read. It touches no
        // MCP table, so it does not wait on the lock we hold.
        await applyImport(db, profileId, makeSnapshot('B'), ownerRef);

        await lockClient.query('COMMIT');

        const result = await resolution;
        expect(result.agents?.map(agent => agent.slug).sort()).toEqual(['agent-a-1', 'agent-a-2']);
        expect(result.kiloCommands?.map(command => command.name)).toEqual(['command-a']);
        expect(result.skills?.map(skill => skill.name)).toEqual(['skill-a']);
        expect(result.instructions?.map(instruction => instruction.name)).toEqual([
          'instruction-a',
        ]);
      } finally {
        await rollbackQuietly(lockClient);
        lockClient.release();
      }
    }, 30000);
  });

  describe('archive limits', () => {
    test('rejects an over-budget encoded body before decoding', async () => {
      const profileId = await createProfile(owner.id, 'Encoded Budget Profile');
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.agentProfiles.previewConfigImport({
          profileId,
          archive: 'A'.repeat(MAX_IMPORT_ENCODED_LENGTH + 1),
        })
      ).rejects.toThrow(/encoded bytes/);
    });

    test('rejects an over-cap compressed archive', () => {
      const parsed = parseLocalConfigArchive(new Uint8Array(MAX_IMPORT_ZIP_BYTES + 1));
      expect(parsed.config).toEqual({ agents: [], commands: [], skills: [], instructions: [] });
      expect(parsed.hasErrors).toBe(true);
      expect(parsed.issues[0]?.code).toBe('archive-too-large');
    });

    test('rejects an over-cap aggregate expansion', () => {
      const entrySize = 1024 * 1024;
      const files: Record<string, string> = {};
      for (let index = 0; index < 33; index += 1) {
        files[`filler/file-${index}.bin`] = 'a'.repeat(entrySize);
      }
      const parsed = parseLocalConfigArchive(buildZip(files));
      expect(parsed.hasErrors).toBe(true);
      expect(parsed.issues.some(issue => issue.code === 'archive-expansion-limit-exceeded')).toBe(
        true
      );
    }, 30000);

    test('rejects an entry-count overflow', () => {
      const files: Record<string, string> = {};
      for (let index = 0; index <= MAX_IMPORT_ARCHIVE_ENTRIES; index += 1) {
        files[`agent/filler-${index}.md`] = 'x';
      }
      const parsed = parseLocalConfigArchive(buildZip(files));
      expect(parsed.hasErrors).toBe(true);
      expect(parsed.issues.some(issue => issue.code === 'archive-entry-count-exceeded')).toBe(true);
    });

    test('apply rejects an archive that exceeds the compressed cap', async () => {
      const profileId = await createProfile(owner.id, 'Over-cap Apply Profile');
      await seedAgent(profileId, 'keep-agent', { prompt: 'keep' });
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.agentProfiles.applyConfigImport({
          profileId,
          archive: encodeArchive(new Uint8Array(MAX_IMPORT_ZIP_BYTES + 1)),
          selection: selectionOf({ agents: ['keep-agent'] }),
        })
      ).rejects.toThrow(/cannot be imported from this archive/);

      const state = await readSnapshotState(profileId);
      expect(state.agents).toEqual(['keep-agent']);
    });
  });
});
