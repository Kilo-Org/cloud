import { describe, expect, test } from 'vitest';
import {
  MAX_PROFILE_COMMAND_LENGTH,
  MAX_PROFILE_COMMANDS,
  setCommands,
} from './profile-commands-service';
import { createProfileWithContent } from './profile-create-service';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };

/** The maximum list: every command exactly at the length bound. */
function commandsAtCap(): string[] {
  return Array.from({ length: MAX_PROFILE_COMMANDS }, () => 'x'.repeat(MAX_PROFILE_COMMAND_LENGTH));
}

describe('createProfileWithContent command bounds', () => {
  test('refuses one command over the list cap without storing anything', async () => {
    const { db, state } = createLimitTestDb(0);
    const overCap = Array.from({ length: MAX_PROFILE_COMMANDS + 1 }, () => 'npm ci');

    await expect(
      createProfileWithContent(db, '', OWNER, OWNER.id, {
        name: 'Over Cap Commands',
        commands: overCap,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${String(MAX_PROFILE_COMMANDS)} setup commands`,
    });

    expect(state.profileInserts).toBe(0);
    expect(state.commands).toEqual([]);
  });

  test('refuses a command one character over the length cap without storing anything', async () => {
    const { db, state } = createLimitTestDb(0);

    await expect(
      createProfileWithContent(db, '', OWNER, OWNER.id, {
        name: 'Long Command',
        commands: ['x'.repeat(MAX_PROFILE_COMMAND_LENGTH + 1)],
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `Setup commands are limited to ${String(MAX_PROFILE_COMMAND_LENGTH)} characters`,
    });

    expect(state.profileInserts).toBe(0);
    expect(state.commands).toEqual([]);
  });

  test('drops a blank command and stores the rest without storing anything else', async () => {
    const { db, state } = createLimitTestDb(0);

    await expect(
      createProfileWithContent(db, '', OWNER, OWNER.id, {
        name: 'Blank Command',
        commands: ['', 'npm ci'],
      })
    ).resolves.toEqual({ id: expect.any(String) });

    expect(state.profileInserts).toBe(1);
    expect(state.commandRows).toEqual([{ command: 'npm ci', sequence: 0 }]);
  });

  test('stores no command rows when every command is blank', async () => {
    const { db, state } = createLimitTestDb(0);

    await expect(
      createProfileWithContent(db, '', OWNER, OWNER.id, {
        name: 'All Blank',
        commands: ['', '   '],
      })
    ).resolves.toEqual({ id: expect.any(String) });

    expect(state.profileInserts).toBe(1);
    expect(state.commands).toEqual([]);
  });

  test('stores exactly the cap of maximum-length commands', async () => {
    const { db, state } = createLimitTestDb(0);
    const atCap = commandsAtCap();

    await expect(
      createProfileWithContent(db, '', OWNER, OWNER.id, { name: 'At Cap', commands: atCap })
    ).resolves.toEqual({ id: expect.any(String) });

    expect(state.profileInserts).toBe(1);
    expect(state.commands).toEqual(atCap);
  });

  test('takes the owner creation lock before it inserts the profile', async () => {
    const { db, state } = createLimitTestDb(0);

    await createProfileWithContent(db, '', OWNER, OWNER.id, {
      name: 'Locked',
      commands: ['npm ci'],
    });

    expect(state.advisoryLocks).toBe(1);
    expect(state.profileInserts).toBe(1);
  });
});

describe('setCommands command bounds', () => {
  test('refuses one command over the list cap and leaves the stored list', async () => {
    const stored = ['npm ci', 'npm test'];
    const { db, state } = createLimitTestDb(0, [], [], stored);
    const overCap = Array.from({ length: MAX_PROFILE_COMMANDS + 1 }, () => 'npm ci');

    await expect(setCommands(db, TEST_PROFILE_ID, overCap, OWNER)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${String(MAX_PROFILE_COMMANDS)} setup commands`,
    });

    // The refusal lands before the delete, so the old list is still there.
    expect(state.commandDeletes).toBe(0);
    expect(state.commands).toEqual(stored);
  });

  test('refuses an over-cap list from a foreign owner with NOT_FOUND', async () => {
    const stored = ['npm ci'];
    const { db, state } = createLimitTestDb(
      1,
      [],
      [{ id: TEST_PROFILE_ID, ownerType: 'user', ownerId: 'other_user', isDefault: false }],
      stored
    );
    const overCap = Array.from({ length: MAX_PROFILE_COMMANDS + 1 }, () => 'npm ci');

    // The ownership check runs first, so a caller without the profile learns
    // that instead of a verdict on the list.
    await expect(setCommands(db, TEST_PROFILE_ID, overCap, OWNER)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Profile not found',
    });

    expect(state.commandDeletes).toBe(0);
    expect(state.commands).toEqual(stored);
  });

  test('refuses a command over the length cap and leaves the stored list', async () => {
    const stored = ['npm ci'];
    const { db, state } = createLimitTestDb(0, [], [], stored);

    await expect(
      setCommands(db, TEST_PROFILE_ID, ['x'.repeat(MAX_PROFILE_COMMAND_LENGTH + 1)], OWNER)
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `Setup commands are limited to ${String(MAX_PROFILE_COMMAND_LENGTH)} characters`,
    });

    expect(state.commandDeletes).toBe(0);
    expect(state.commands).toEqual(stored);
  });

  test('replaces the stored list with exactly the cap of maximum-length commands', async () => {
    const { db, state } = createLimitTestDb(0, [], [], ['npm ci']);
    const atCap = commandsAtCap();

    await expect(setCommands(db, TEST_PROFILE_ID, atCap, OWNER)).resolves.toBeUndefined();

    expect(state.commandDeletes).toBe(1);
    expect(state.commands).toEqual(atCap);
  });

  test('drops blank commands and renumbers the stored sequence', async () => {
    const { db, state } = createLimitTestDb(0, [], [], ['npm ci']);

    await expect(
      setCommands(db, TEST_PROFILE_ID, ['npm ci', '', '  ', 'npm test'], OWNER)
    ).resolves.toBeUndefined();

    expect(state.commandDeletes).toBe(1);
    expect(state.commandInserts).toBe(1);
    expect(state.commandRows).toEqual([
      { command: 'npm ci', sequence: 0 },
      { command: 'npm test', sequence: 1 },
    ]);
  });

  test('deletes the stored list and inserts nothing when every command is blank', async () => {
    const { db, state } = createLimitTestDb(0, [], [], ['npm ci', 'npm test']);

    await expect(setCommands(db, TEST_PROFILE_ID, ['', '   '], OWNER)).resolves.toBeUndefined();

    expect(state.commandDeletes).toBe(1);
    expect(state.commandInserts).toBe(0);
    expect(state.commands).toEqual([]);
  });

  test('accepts a list at the cap once blank commands are dropped', async () => {
    const { db, state } = createLimitTestDb(0, [], [], ['npm ci']);
    const atCap = commandsAtCap();
    const withBlanks = [...atCap, '', '  '];

    await expect(setCommands(db, TEST_PROFILE_ID, withBlanks, OWNER)).resolves.toBeUndefined();

    expect(state.commandDeletes).toBe(1);
    expect(state.commands).toEqual(atCap);
  });

  test('refuses when the commands that survive dropping blanks exceed the cap', async () => {
    const stored = ['npm ci'];
    const { db, state } = createLimitTestDb(0, [], [], stored);
    const overCap = [...Array.from({ length: MAX_PROFILE_COMMANDS + 1 }, () => 'npm ci'), '', '  '];

    await expect(setCommands(db, TEST_PROFILE_ID, overCap, OWNER)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${String(MAX_PROFILE_COMMANDS)} setup commands`,
    });

    expect(state.commandDeletes).toBe(0);
    expect(state.commands).toEqual(stored);
  });
});
