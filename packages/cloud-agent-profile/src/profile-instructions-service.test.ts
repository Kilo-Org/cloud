import { describe, test, expect } from 'vitest';
import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_instructions,
  agent_environment_profiles,
} from '@kilocode/db/schema';
import {
  MAX_PROFILE_INSTRUCTIONS,
  instructionCreateInputSchema,
  instructionUpdateInputSchema,
  createInstruction,
  updateInstruction,
} from './profile-instructions-service';
import { MAX_IMPORT_INSTRUCTIONS } from './import/instructions';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Minimal instruction-store stand-in. Transactions are serialized so the
 * service's count-then-insert sequence inside its transaction runs in order.
 * It does not model PostgreSQL row-lock visibility: the `.for('update')` call
 * is only counted, and no two-connection lock-ordering test exists here.
 */
function createInstructionServiceDb(options: {
  profileExists?: boolean;
  instructionCount?: number;
}) {
  const profileExists = options.profileExists ?? true;
  const state = {
    instructionCount: options.instructionCount ?? 0,
    inserted: [] as Array<{ name: string; content: string }>,
    lockCalls: 0,
    updateSets: [] as Array<Record<string, unknown>>,
  };

  function buildSelect(table: unknown) {
    const resolveRows = () => {
      if (table === agent_environment_profiles) {
        return profileExists ? [{ id: PROFILE_ID }] : [];
      }
      if (table === agent_environment_profile_instructions) {
        return [{ n: state.instructionCount }];
      }
      throw new Error('Instruction service test db: unexpected table');
    };

    const result = {
      for: () => {
        state.lockCalls += 1;
        return result;
      },
      limit: () => Promise.resolve(resolveRows()),
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
        Promise.resolve(resolveRows()).then(onFulfilled, onRejected),
    };
    return result;
  }

  const select = () => ({ from: (table: unknown) => ({ where: () => buildSelect(table) }) });
  const insert = () => ({
    values: (row: { name: string; content: string }) => ({
      returning: () => {
        state.instructionCount += 1;
        state.inserted.push({ name: row.name, content: row.content });
        return Promise.resolve([{ id: `instruction-${state.instructionCount}` }]);
      },
    }),
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      state.updateSets.push(values);
      return { where: () => Promise.resolve(undefined) };
    },
  });

  const tx = { select, insert, update };
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    select,
    insert,
    update,
    transaction: <T>(work: (transaction: typeof tx) => Promise<T>): Promise<T> => {
      const run = tail.then(() => work(tx));
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };

  return { db: db as unknown as WorkerDb, state };
}

describe('instructionCreateInputSchema', () => {
  test('accepts a minimal valid instruction', () => {
    expect(
      instructionCreateInputSchema.safeParse({ name: 'repo-rules', content: 'Follow the policy' })
        .success
    ).toBe(true);
  });

  test('accepts a lowercase slug with dashes and digits after the first character', () => {
    expect(
      instructionCreateInputSchema.safeParse({ name: 'rules-2024', content: 'body' }).success
    ).toBe(true);
  });

  test('rejects uppercase, spaces, underscores and leading dashes', () => {
    for (const name of ['Rules', 'repo rules', 'repo_rules', '-rules', 'repo.rules']) {
      expect(instructionCreateInputSchema.safeParse({ name, content: 'body' }).success).toBe(false);
    }
  });

  test('rejects the reserved cloud-agent rules filename', () => {
    const result = instructionCreateInputSchema.safeParse({
      name: 'cloud-agent',
      content: 'hijack the reserved rules file',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Cloud-Agent-owned rules file');
    }
  });

  test('rejects an empty name and an over-long name', () => {
    expect(instructionCreateInputSchema.safeParse({ name: '', content: 'body' }).success).toBe(
      false
    );
    expect(
      instructionCreateInputSchema.safeParse({ name: 'a'.repeat(101), content: 'body' }).success
    ).toBe(false);
  });

  test('rejects empty content and content over the size limit', () => {
    expect(instructionCreateInputSchema.safeParse({ name: 'rules', content: '' }).success).toBe(
      false
    );
    expect(
      instructionCreateInputSchema.safeParse({ name: 'rules', content: 'x'.repeat(100_001) })
        .success
    ).toBe(false);
  });

  test('shares the documented per-profile instruction cap with the import contract', () => {
    expect(MAX_PROFILE_INSTRUCTIONS).toBe(50);
    expect(MAX_PROFILE_INSTRUCTIONS).toBe(MAX_IMPORT_INSTRUCTIONS);
  });
});

describe('instructionUpdateInputSchema', () => {
  test('accepts an empty update', () => {
    expect(instructionUpdateInputSchema.safeParse({}).success).toBe(true);
  });

  test('accepts a partial update', () => {
    expect(instructionUpdateInputSchema.safeParse({ content: 'New content' }).success).toBe(true);
    expect(instructionUpdateInputSchema.safeParse({ name: 'new-name' }).success).toBe(true);
  });

  test('rejects an invalid name in an update', () => {
    expect(instructionUpdateInputSchema.safeParse({ name: 'INVALID' }).success).toBe(false);
    expect(instructionUpdateInputSchema.safeParse({ name: 'cloud-agent' }).success).toBe(false);
  });
});

describe('createInstruction validation', () => {
  test('rejects the reserved cloud-agent name without touching the store', async () => {
    const { db, state } = createInstructionServiceDb({});

    await expect(
      createInstruction(db, PROFILE_ID, { name: 'cloud-agent', content: 'body' }, OWNER)
    ).rejects.toThrow(/Cloud-Agent-owned rules file/);
    expect(state.lockCalls).toBe(0);
    expect(state.inserted).toHaveLength(0);
  });

  test('rejects an unsafe name and oversized content without touching the store', async () => {
    const { db, state } = createInstructionServiceDb({});

    await expect(
      createInstruction(db, PROFILE_ID, { name: '../escape', content: 'body' }, OWNER)
    ).rejects.toThrow(/lowercase slug/);
    await expect(
      createInstruction(db, PROFILE_ID, { name: 'rules', content: 'x'.repeat(100_001) }, OWNER)
    ).rejects.toThrow(/exceeds/);
    expect(state.lockCalls).toBe(0);
    expect(state.inserted).toHaveLength(0);
  });

  test('rejects a missing profile', async () => {
    const { db, state } = createInstructionServiceDb({ profileExists: false });

    await expect(
      createInstruction(db, PROFILE_ID, { name: 'repo-rules', content: 'body' }, OWNER)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(state.inserted).toHaveLength(0);
  });
});

describe('updateInstruction validation', () => {
  test('rejects the reserved cloud-agent name without updating the store', async () => {
    const { db, state } = createInstructionServiceDb({});

    await expect(
      updateInstruction(db, PROFILE_ID, 'instruction-1', { name: 'cloud-agent' }, OWNER)
    ).rejects.toThrow(/Cloud-Agent-owned rules file/);
    expect(state.updateSets).toHaveLength(0);
  });
});

describe('createInstruction cap enforcement', () => {
  test('stores an instruction while the profile is below the cap', async () => {
    const { db, state } = createInstructionServiceDb({
      instructionCount: MAX_PROFILE_INSTRUCTIONS - 1,
    });

    await expect(
      createInstruction(db, PROFILE_ID, { name: 'repo-rules', content: 'Follow the policy' }, OWNER)
    ).resolves.toEqual({ id: expect.any(String) });
    expect(state.inserted).toEqual([{ name: 'repo-rules', content: 'Follow the policy' }]);
  });

  test('rejects a create at the cap without inserting', async () => {
    const { db, state } = createInstructionServiceDb({
      instructionCount: MAX_PROFILE_INSTRUCTIONS,
    });

    await expect(
      createInstruction(db, PROFILE_ID, { name: 'repo-rules', content: 'Follow the policy' }, OWNER)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(state.inserted).toHaveLength(0);
  });

  test('serializes concurrent creates at the cap so the stored count never exceeds it', async () => {
    const { db, state } = createInstructionServiceDb({
      instructionCount: MAX_PROFILE_INSTRUCTIONS - 1,
    });

    const results = await Promise.allSettled([
      createInstruction(db, PROFILE_ID, { name: 'first', content: 'body' }, OWNER),
      createInstruction(db, PROFILE_ID, { name: 'second', content: 'body' }, OWNER),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    const rejected = results[1];
    expect(rejected.status === 'rejected' && rejected.reason).toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(state.lockCalls).toBe(2);
    expect(state.instructionCount).toBe(MAX_PROFILE_INSTRUCTIONS);
  });
});
