import { describe, test, expect } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profiles,
  agent_environment_profile_kilo_commands,
} from '@kilocode/db/schema';
import {
  MAX_PROFILE_KILO_COMMANDS,
  kiloCommandNameSchema,
  kiloCommandReorderIdsSchema,
  kiloCommandCreateInputSchema,
  kiloCommandUpdateInputSchema,
  BUILTIN_COMMAND_NAMES,
  reorderKiloCommands,
  createKiloCommand,
  type KiloCommandCreateInput,
} from './profile-kilo-commands-service';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };

function commandId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * Stand-in for the command store. Ownership reads resolve to one profile row;
 * the reorder read resolves to the rows this test says the profile owns, so a
 * requested id outside that set exercises the conflict path. Writes are only
 * recorded.
 */
function createReorderServiceDb(options: { profileExists?: boolean; ownedIds?: string[] }) {
  const profileExists = options.profileExists ?? true;
  const ownedIds = options.ownedIds ?? [];
  const state = { updateSets: [] as Array<Record<string, unknown>> };

  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === agent_environment_profiles) {
          return { limit: () => Promise.resolve(profileExists ? [{ id: PROFILE_ID }] : []) };
        }
        if (table === agent_environment_profile_kilo_commands) {
          return Promise.resolve(ownedIds.map(id => ({ id })));
        }
        throw new Error('reorder service test db: unexpected table');
      },
    }),
  });

  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        state.updateSets.push(values);
        return Promise.resolve(undefined);
      },
    }),
  });

  const tx = { select, update };
  const db = {
    select,
    update,
    transaction: <T>(work: (transaction: typeof tx) => Promise<T>): Promise<T> => work(tx),
  };

  return { db: db as unknown as WorkerDb, state };
}

function commandInput(name: string): KiloCommandCreateInput {
  return { name, template: `Run ${name}` };
}

describe('kiloCommandNameSchema', () => {
  test('accepts valid slug', () => {
    expect(kiloCommandNameSchema.safeParse('commit').success).toBe(true);
  });

  test('accepts slug with dashes', () => {
    expect(kiloCommandNameSchema.safeParse('my-command').success).toBe(true);
  });

  test('accepts slug with digits after first char', () => {
    expect(kiloCommandNameSchema.safeParse('deploy2').success).toBe(true);
  });

  test('rejects uppercase', () => {
    expect(kiloCommandNameSchema.safeParse('Commit').success).toBe(false);
  });

  test('rejects starting with digit', () => {
    expect(kiloCommandNameSchema.safeParse('1command').success).toBe(false);
  });

  test('rejects underscores', () => {
    expect(kiloCommandNameSchema.safeParse('my_command').success).toBe(false);
  });

  test('rejects spaces', () => {
    expect(kiloCommandNameSchema.safeParse('my command').success).toBe(false);
  });

  test('rejects empty string', () => {
    expect(kiloCommandNameSchema.safeParse('').success).toBe(false);
  });

  test('rejects built-in command name', () => {
    const result = kiloCommandNameSchema.safeParse('review');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('built-in');
    }
  });

  test('rejects all built-in command names', () => {
    for (const name of BUILTIN_COMMAND_NAMES) {
      expect(kiloCommandNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe('kiloCommandCreateInputSchema', () => {
  test('accepts minimal valid input', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: 'Deploy the application',
    });
    expect(result.success).toBe(true);
  });

  test('accepts full valid input', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      description: 'Deploy to production',
      template: 'Deploy $ARGUMENTS to production',
      agent: 'code',
      model: 'claude-3',
      subtask: true,
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing name', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      template: 'Deploy',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing template', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty template', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects template exceeding max length', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: 'x'.repeat(100_001),
    });
    expect(result.success).toBe(false);
  });

  test('rejects description exceeding max length', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: 'Deploy',
      description: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('kiloCommandUpdateInputSchema', () => {
  test('accepts empty update', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts partial update', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({
      template: 'New template',
      subtask: true,
    });
    expect(result.success).toBe(true);
  });

  test('allows nulling optional fields', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({
      description: null,
      agent: null,
      model: null,
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid name in update', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({
      name: 'INVALID',
    });
    expect(result.success).toBe(false);
  });
});

describe('kiloCommandReorderIdsSchema', () => {
  test('accepts a distinct list at the profile command limit', () => {
    const ids = Array.from({ length: MAX_PROFILE_KILO_COMMANDS }, (_, index) => commandId(index));
    expect(kiloCommandReorderIdsSchema.safeParse(ids).success).toBe(true);
  });

  test('rejects a list longer than the profile command limit', () => {
    const ids = Array.from({ length: MAX_PROFILE_KILO_COMMANDS + 1 }, (_, index) =>
      commandId(index)
    );
    expect(kiloCommandReorderIdsSchema.safeParse(ids).success).toBe(false);
  });

  test('rejects a repeated id', () => {
    expect(kiloCommandReorderIdsSchema.safeParse([commandId(1), commandId(1)]).success).toBe(false);
  });
});

describe('reorderKiloCommands', () => {
  test('applies the whole order in a single set-based update', async () => {
    const ids = [commandId(1), commandId(2), commandId(3)];
    const { db, state } = createReorderServiceDb({ ownedIds: ids });

    await reorderKiloCommands(db, PROFILE_ID, [ids[2], ids[0], ids[1]], OWNER);

    expect(state.updateSets).toHaveLength(1);
    const sortOrder = state.updateSets[0].sort_order;
    if (!(sortOrder instanceof SQL)) {
      throw new Error('sort_order must be a SQL expression');
    }
    const params = new PgDialect().sqlToQuery(sortOrder).params;
    expect(params).toEqual(expect.arrayContaining([ids[2], 0, ids[0], 1, ids[1], 2]));
  });

  test('rejects a list longer than the profile limit before writing', async () => {
    const ids = Array.from({ length: MAX_PROFILE_KILO_COMMANDS + 1 }, (_, index) =>
      commandId(index)
    );
    const { db, state } = createReorderServiceDb({ ownedIds: ids });

    await expect(reorderKiloCommands(db, PROFILE_ID, ids, OWNER)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(state.updateSets).toHaveLength(0);
  });

  test('treats an empty order as a no-op', async () => {
    const { db, state } = createReorderServiceDb({ ownedIds: [] });

    await reorderKiloCommands(db, PROFILE_ID, [], OWNER);

    expect(state.updateSets).toHaveLength(0);
  });

  test('rejects a repeated id before writing', async () => {
    const ids = [commandId(1), commandId(2)];
    const { db, state } = createReorderServiceDb({ ownedIds: ids });

    await expect(
      reorderKiloCommands(db, PROFILE_ID, [ids[0], ids[1], ids[0]], OWNER)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(state.updateSets).toHaveLength(0);
  });

  test('rejects an id the profile does not own before writing', async () => {
    const owned = [commandId(1), commandId(2)];
    const { db, state } = createReorderServiceDb({ ownedIds: owned });

    await expect(
      reorderKiloCommands(db, PROFILE_ID, [owned[0], commandId(9), owned[1]], OWNER)
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.updateSets).toHaveLength(0);
  });
});

describe('createKiloCommand cap enforcement', () => {
  test('stores a command while the profile is below the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_KILO_COMMANDS - 1);

    await expect(
      createKiloCommand(db, TEST_PROFILE_ID, commandInput('deploy'), OWNER)
    ).resolves.toEqual({ id: expect.any(String) });
    expect(state.rowCount).toBe(MAX_PROFILE_KILO_COMMANDS);
    expect(state.lockCalls).toBe(1);
  });

  test('rejects a create at the cap without inserting', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_KILO_COMMANDS);

    await expect(
      createKiloCommand(db, TEST_PROFILE_ID, commandInput('deploy'), OWNER)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(state.rowCount).toBe(MAX_PROFILE_KILO_COMMANDS);
    expect(state.lockCalls).toBe(1);
  });

  test('keeps concurrent creates within the per-profile cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_KILO_COMMANDS - 1);

    const results = await Promise.allSettled([
      createKiloCommand(db, TEST_PROFILE_ID, commandInput('first'), OWNER),
      createKiloCommand(db, TEST_PROFILE_ID, commandInput('second'), OWNER),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(state.rowCount).toBe(MAX_PROFILE_KILO_COMMANDS);
    expect(state.lockCalls).toBe(2);
  });
});
