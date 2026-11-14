import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PermissionMap } from '../../../src/shared/profile-permission-policy.js';
import { activityFixture } from './kilo-activity-fixture.js';
import { profileConfigPath } from './runtime-profile.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

type Fixture = Awaited<ReturnType<typeof activityFixture>>;
type ToolCall = { name: string; arguments: Record<string, unknown> };

/** The command guard's map for a code-review session: inspection only. */
const SESSION_PERMISSION: PermissionMap = {
  edit: 'deny',
  bash: { '*': 'deny', 'git log': 'allow', 'git log *': 'allow', 'npm *': 'deny' },
  webfetch: 'deny',
};

/**
 * Refusal wordings the pinned CLI emits. A whole-tool deny removes the tool, so
 * a call to it never starts; a per-pattern deny rejects the one call.
 */
const REFUSAL = /unavailable tool 'edit'|prevents you from using this specific tool call/;

function profileAgent(slug: string, permission: Record<string, unknown>) {
  return {
    slug,
    name: `Profile ${slug}`,
    config: { mode: 'primary' as const, prompt: `Profile agent ${slug}`, permission },
  };
}

/**
 * The agent entry the production writer left in the profile config. Narrowing
 * happens inside `writeRuntimeProfileConfig`, so this is what the CLI reads.
 */
async function writtenAgent(fixture: Fixture, slug: string) {
  const raw = await fs.readFile(profileConfigPath(fixture.root), 'utf8');
  const config = JSON.parse(raw) as {
    agent?: Record<string, { mode?: string; prompt?: string; permission?: unknown }>;
  };
  return config.agent?.[slug];
}

/** Answer the first model request with these tool calls, then close the turn. */
function requestToolOnce(fixture: Fixture, tools: ToolCall[]): void {
  let requested = false;
  fixture.respond(async () => {
    if (requested) return { text: 'done' };
    requested = true;
    return { tools };
  });
}

/** The settled tool part of a session, after the turn reaches idle. */
async function settledTool(fixture: Fixture, sessionID: string, tool: string) {
  const result = await fixture.until(
    () =>
      fixture.client.session.messages(
        { sessionID, directory: fixture.directory },
        { signal: fixture.signal }
      ),
    messages =>
      messages.data?.some(message =>
        message.parts.some(
          part =>
            part.type === 'tool' &&
            part.tool === tool &&
            (part.state.status === 'completed' || part.state.status === 'error')
        )
      ) === true,
    `${tool} tool result`
  );
  await fixture.idle(sessionID);
  const part = result.data
    ?.flatMap(message => message.parts)
    .find(part => part.type === 'tool' && part.tool === tool);
  if (part?.type !== 'tool') throw new Error(`Missing ${tool} tool part`);
  return part.state;
}

/** Commit one file so an allowed `git log` has something to print. */
async function initializeRepository(directory: string): Promise<void> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: directory, env, stderr: 'pipe' });
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  };
  git(['init', '--quiet']);
  await fs.writeFile(path.join(directory, 'fixture.txt'), 'fixture-commit\n');
  git(['add', 'fixture.txt']);
  git(['commit', '--quiet', '-m', 'fixture-commit']);
}

suite('pinned Kilo profile permission narrowing', () => {
  it('applies the session refusal to an edit that a profile agent permits', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const fixture = await activityFixture(binary, {
      permission: SESSION_PERMISSION,
      runtimeAgents: [profileAgent('profile-editor', { edit: 'allow' })],
    });
    try {
      // The written entry carries the session policy and no agent allowance.
      expect(await writtenAgent(fixture, 'profile-editor')).toEqual({
        mode: 'primary',
        prompt: 'Profile agent profile-editor',
      });
      const target = path.join(fixture.directory, 'target.txt');
      await fs.writeFile(target, 'fixture-original\n');
      requestToolOnce(fixture, [
        {
          name: 'edit',
          arguments: {
            filePath: target,
            oldString: 'fixture-original',
            newString: 'fixture-mutated',
          },
        },
      ]);
      const sessionID = await fixture.session();
      await fixture.prompt(
        sessionID,
        'mutate the fixture file',
        fixture.directory,
        'profile-editor'
      );
      const state = await settledTool(fixture, sessionID, 'edit');
      expect(state.status).toBe('error');
      if (state.status !== 'error') throw new Error('The edit tool did not fail');
      expect(state.error).toMatch(REFUSAL);
      expect(await fs.readFile(target, 'utf8')).toBe('fixture-original\n');
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it('applies the session refusal to an excluded command without asking a human', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const fixture = await activityFixture(binary, {
      permission: SESSION_PERMISSION,
      runtimeAgents: [profileAgent('profile-runner', { bash: { '*': 'allow' } })],
    });
    try {
      // The session policy decides every command, so its refusal is written.
      expect((await writtenAgent(fixture, 'profile-runner'))?.permission).toEqual({
        bash: { 'npm *': 'deny' },
      });
      requestToolOnce(fixture, [{ name: 'bash', arguments: { command: 'npm test' } }]);
      const sessionID = await fixture.session();
      await fixture.prompt(sessionID, 'run the package tests', fixture.directory, 'profile-runner');
      const state = await settledTool(fixture, sessionID, 'bash');
      expect(state.status).toBe('error');
      if (state.status !== 'error') throw new Error('The denied command did not fail');
      expect(state.error).toContain(
        'The user has specified a rule which prevents you from using this specific tool call.'
      );
      expect(state.error).toContain('"pattern":"npm *"');
      expect(state.error).toContain('"action":"deny"');
      expect(
        fixture.sessionEvents(sessionID).filter(event => event.type === 'permission.asked')
      ).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it('applies a flat session action to a pattern-map agent entry', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const fixture = await activityFixture(binary, {
      permission: SESSION_PERMISSION,
      runtimeAgents: [profileAgent('profile-mapper', { edit: { '*': 'allow' } })],
    });
    try {
      // The session states edit as one flat action, so the entry carries it.
      expect((await writtenAgent(fixture, 'profile-mapper'))?.permission).toEqual({
        edit: { '*': 'deny' },
      });
      const target = path.join(fixture.directory, 'mapped.txt');
      await fs.writeFile(target, 'fixture-original\n');
      requestToolOnce(fixture, [
        {
          name: 'edit',
          arguments: {
            filePath: target,
            oldString: 'fixture-original',
            newString: 'fixture-mutated',
          },
        },
      ]);
      const sessionID = await fixture.session();
      await fixture.prompt(
        sessionID,
        'mutate the fixture file',
        fixture.directory,
        'profile-mapper'
      );
      const state = await settledTool(fixture, sessionID, 'edit');
      expect(state.status).toBe('error');
      if (state.status !== 'error') throw new Error('The edit tool did not fail');
      expect(state.error).toMatch(REFUSAL);
      expect(await fs.readFile(target, 'utf8')).toBe('fixture-original\n');
    } finally {
      await fixture.dispose();
    }
  }, 60_000);

  it('runs an inspection command that both policies allow', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const fixture = await activityFixture(binary, {
      permission: SESSION_PERMISSION,
      runtimeAgents: [profileAgent('profile-inspector', { bash: { '*': 'allow' } })],
    });
    try {
      await initializeRepository(fixture.directory);
      requestToolOnce(fixture, [{ name: 'bash', arguments: { command: 'git log --oneline -1' } }]);
      const sessionID = await fixture.session();
      await fixture.prompt(
        sessionID,
        'inspect the repository',
        fixture.directory,
        'profile-inspector'
      );
      const state = await settledTool(fixture, sessionID, 'bash');
      expect(state.status).toBe('completed');
      if (state.status !== 'completed') throw new Error('The allowed command did not complete');
      expect(state.output).toMatch(/^[0-9a-f]+ fixture-commit\n?$/);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
