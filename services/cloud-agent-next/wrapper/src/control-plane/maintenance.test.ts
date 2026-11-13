import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { createMaintenanceGit } from './maintenance-git.js';
import { createMaintenanceExecution } from './maintenance-execution.js';
import { createMaintenanceRebase } from './maintenance-rebase.js';
import { git as runGit } from '../utils.js';
import {
  MAINTENANCE_PUBLICATION_EVENT,
  type MaintenanceChat,
  type MaintenanceOutcome,
} from '../../../src/shared/pr-maintenance.js';
import { createTurnManager, type TurnKiloRuntime } from './turn.js';
import type { Harness } from './harness.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type {
  ControlPlaneRouteSpec,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';

const attemptId = '11111111-1111-4111-8111-111111111111';
const watchId = '22222222-2222-4222-8222-222222222222';
const repoUrl = 'https://github.com/example/maintenance-fixture';
const directories: string[] = [];
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(directory: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: directory,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pr-maintenance-'));
  directories.push(directory);
  const remote = path.join(directory, 'remote.git');
  const seed = path.join(directory, 'seed');
  const checkout = path.join(directory, 'checkout');
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', remote, seed);
  await writeFile(path.join(seed, 'conflict.txt'), 'initial\n');
  git(seed, 'add', 'conflict.txt');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', 'origin', 'main');
  git(seed, 'checkout', '-b', 'feature/fix');
  await writeFile(path.join(seed, 'conflict.txt'), 'feature\n');
  git(seed, 'add', 'conflict.txt');
  git(seed, 'commit', '-m', 'feature');
  git(seed, 'push', 'origin', 'feature/fix');
  git(directory, 'clone', '--branch', 'feature/fix', remote, checkout);
  git(checkout, 'remote', 'set-url', 'origin', repoUrl);
  git(checkout, 'config', `url.${remote}.insteadOf`, repoUrl);
  const observedHeadSha = git(checkout, 'rev-parse', 'HEAD');
  const chat: MaintenanceChat = {
    kind: 'maintenance',
    watchId,
    attemptId,
    publication: {
      repoUrl,
      headRef: 'feature/fix',
      baseRef: 'main',
      observedHeadSha,
      baseSha: git(checkout, 'rev-parse', 'origin/main'),
    },
  };
  return { directory, remote, seed, checkout, chat };
}

async function conflictingRebase() {
  const value = await fixture();
  return startConflict(value);
}

async function startConflict(value: Awaited<ReturnType<typeof fixture>>) {
  git(value.seed, 'checkout', 'main');
  await writeFile(path.join(value.seed, 'conflict.txt'), 'base\n');
  git(value.seed, 'add', 'conflict.txt');
  git(value.seed, 'commit', '-m', 'base conflict');
  git(value.seed, 'push', 'origin', 'main');
  git(value.checkout, 'fetch', 'origin', 'main');
  expect(() => git(value.checkout, 'rebase', 'origin/main')).toThrow();
  const marker = path.resolve(
    value.checkout,
    git(value.checkout, 'rev-parse', '--git-path', 'kilo-maintenance-rebase')
  );
  return { ...value, marker };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('connected maintenance turn behavior', () => {
  it.each(['stop', 'failure', 'completion', 'release', 'shutdown'] as const)(
    'allows an independent user sibling and cleans the owned rebase on %s',
    async terminalPath => {
      const value = await fixture();
      const prompts: string[] = [];
      const frames: ControlPlaneWrapperFrame[] = [];
      let autoCommits = 0;
      const interruptStarted = Promise.withResolvers<void>();
      const interruptReleased = Promise.withResolvers<void>();
      const client = {
        submit: async (input: { sessionId: string }) => {
          prompts.push(input.sessionId);
        },
        interrupt: async () => {
          interruptStarted.resolve();
          if (terminalPath === 'stop') await interruptReleased.promise;
          return true;
        },
      } as unknown as Harness;
      const runtime: TurnKiloRuntime = {
        nativeRuntimeId: 'rt',
        directory: value.checkout,
        env,
        client,
        ensure: async () => client,
        isSuspected: () => false,
        isRestarting: () => false,
        isUnavailable: () => false,
        isRetiredClient: () => false,
        sessionState: () => undefined,
        liveTreeExecutions: () => undefined,
        refreshActivity: async () => {},
      };
      const turns = createTurnManager({
        timers: CONTROL_PLANE_TIMERS,
        runtimes: { get: () => runtime },
        emit: frame => {
          frames.push(frame);
        },
        runAutoCommit: async () => {
          autoCommits += 1;
          throw new Error('Must not auto-commit maintenance');
        },
      });
      const spec: ControlPlaneRouteSpec = {
        sessionId: 'workspace_maintenance',
        kiloSessionId: 'ses_maintenance',
        directory: value.checkout,
        attemptId: 'route_attempt',
        maintenance: value.chat,
      };
      const waitUntil = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
        expect(predicate()).toBe(true);
      };
      try {
        turns.registerRoute(spec);
        turns.submit(spec.sessionId, {
          messageId: 'msg_maintenance',
          turn: { type: 'prompt', prompt: 'Repair.' },
          agent: { mode: 'code', model: 'test/model' },
          finalization: { autoCommit: true },
        });
        await waitUntil(() => prompts.includes(spec.kiloSessionId));
        turns.observeKiloEvent({
          type: MAINTENANCE_PUBLICATION_EVENT,
          nativeRuntimeId: 'rt',
          properties: { sessionID: spec.kiloSessionId, publication: { status: 'published' } },
        });
        expect(
          frames.some(
            frame =>
              frame.type === 'session.events' &&
              frame.events.some(event => event.type === MAINTENANCE_PUBLICATION_EVENT)
          )
        ).toBe(false);
        turns.registerRoute({
          ...spec,
          sessionId: 'workspace_user',
          kiloSessionId: 'ses_user',
          maintenance: undefined,
        });
        turns.submit('workspace_user', {
          messageId: 'msg_user',
          turn: { type: 'prompt', prompt: 'User work.' },
          agent: { mode: 'code', model: 'test/model' },
        });
        await waitUntil(() => prompts.includes('ses_user'));
        expect(
          frames.some(
            frame => frame.type === 'session.outcome' && frame.sessionId === spec.sessionId
          )
        ).toBe(false);
        const conflict = await startConflict(value);
        await writeFile(conflict.marker, attemptId);
        await writeFile(path.join(value.checkout, 'user-unfinished.txt'), 'user work\n');
        turns.observeActivity({
          nativeRuntimeId: 'rt',
          activity: {
            type: 'message',
            message: { sessionId: spec.kiloSessionId, id: 'msg_maintenance', role: 'user' },
          },
        });
        if (terminalPath === 'release') await turns.release(spec.sessionId);
        else if (terminalPath === 'shutdown') await turns.shutdown();
        else {
          if (terminalPath === 'stop') {
            turns.abort(spec.sessionId);
            await interruptStarted.promise;
            turns.submit(spec.sessionId, {
              messageId: 'msg_maintenance',
              turn: { type: 'prompt', prompt: 'Repair.' },
              agent: { mode: 'code', model: 'test/model' },
              finalization: { autoCommit: true },
            });
            interruptReleased.resolve();
          } else
            turns.observeKiloEvent({
              type: terminalPath === 'completion' ? 'session.turn.close' : 'session.error',
              nativeRuntimeId: 'rt',
              properties: {
                sessionID: spec.kiloSessionId,
                reason: terminalPath === 'completion' ? 'completed' : 'error',
                error: 'Synthetic failure',
              },
            });
          await waitUntil(() =>
            frames.some(
              frame => frame.type === 'session.outcome' && frame.sessionId === spec.sessionId
            )
          );
        }
        expect(git(value.checkout, 'branch', '--show-current')).toBe('feature/fix');
        expect(await readFile(path.join(value.checkout, 'user-unfinished.txt'), 'utf8')).toBe(
          'user work\n'
        );
        expect(autoCommits).toBe(0);
        if (terminalPath === 'stop') {
          await Bun.sleep(100);
          expect(prompts.filter(id => id === spec.kiloSessionId)).toHaveLength(1);
        }
        const outcome = frames.find(
          frame => frame.type === 'session.outcome' && frame.sessionId === spec.sessionId
        );
        if (terminalPath === 'release' || terminalPath === 'shutdown')
          expect(outcome).toBeUndefined();
        else
          expect(outcome).toMatchObject({
            status:
              terminalPath === 'stop'
                ? 'cancelled'
                : terminalPath === 'completion'
                  ? 'completed'
                  : 'failed',
            lastMessageId: 'msg_maintenance',
            maintenance: {
              attemptId,
              messageId: 'msg_maintenance',
              publication: { status: 'not_attempted' },
            },
          });
        expect(
          frames.some(
            frame => frame.type === 'session.outcome' && frame.sessionId === 'workspace_user'
          )
        ).toBe(false);
      } finally {
        interruptReleased.resolve();
        await turns.shutdown();
      }
    }
  );
});

describe('maintenance Git evidence and rebase ownership', () => {
  it('records actual completed owned rebase evidence independently of input problem kinds', async () => {
    const value = await fixture();
    git(value.seed, 'checkout', 'main');
    await writeFile(path.join(value.seed, 'conflict.txt'), 'base update\n');
    git(value.seed, 'add', 'conflict.txt');
    git(value.seed, 'commit', '-m', 'base update');
    git(value.seed, 'push', 'origin', 'main');
    const chat = { ...value.chat, allowRebase: true };
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    const rebase = createMaintenanceRebase(chat, commands);
    expect(await rebase.start(new AbortController().signal)).toMatchObject({ status: 'conflicts' });
    await writeFile(path.join(value.checkout, 'conflict.txt'), 'base and feature\n');
    git(value.checkout, 'add', 'conflict.txt');
    expect(await rebase.continueRebase(new AbortController().signal)).toMatchObject({
      status: 'completed',
    });
    const evidence = await rebase.publicationEvidence();
    expect(evidence).toMatchObject({
      source: 'git',
      attemptId,
      previousHeadSha: chat.publication.observedHeadSha,
      baseSha: git(value.checkout, 'rev-parse', 'origin/main'),
      rebasedHeadSha: git(value.checkout, 'rev-parse', 'HEAD'),
    });
    const restored = createMaintenanceRebase(chat, commands);
    expect(await restored.publicationEvidence()).toEqual(evidence);
    expect(
      await commands.publish(
        chat.publication,
        chat.publication.observedHeadSha,
        new AbortController().signal,
        evidence
      )
    ).toMatchObject({ status: 'published', ownedRebase: evidence });
  });

  it('honors disabled conflict repairs and does not rebase a clean non-conflicting target update', async () => {
    const value = await fixture();
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    expect(
      await createMaintenanceRebase({ ...value.chat, allowRebase: false }, commands).start(
        new AbortController().signal
      )
    ).toMatchObject({ status: 'blocked', reason: 'maintenance_conflict_repairs_disabled' });
    git(value.seed, 'checkout', 'main');
    await writeFile(path.join(value.seed, 'base-only.txt'), 'base\n');
    git(value.seed, 'add', 'base-only.txt');
    git(value.seed, 'commit', '-m', 'clean base update');
    git(value.seed, 'push', 'origin', 'main');
    const rebase = createMaintenanceRebase({ ...value.chat, allowRebase: true }, commands);
    expect(await rebase.start(new AbortController().signal)).toMatchObject({
      status: 'not_needed',
    });
    expect(await rebase.publicationEvidence()).toBeUndefined();
    expect(git(value.checkout, 'rev-parse', 'HEAD')).toBe(value.chat.publication.observedHeadSha);
  });

  it('does not promote a claimed completed-rebase file without a real Git rebase finish', async () => {
    const value = await fixture();
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    await writeFile(
      await commands.gitPath('kilo-maintenance-rebase-completed'),
      JSON.stringify({
        source: 'git',
        attemptId,
        baseSha: value.chat.publication.baseSha,
        previousHeadSha: value.chat.publication.observedHeadSha,
        rebasedHeadSha: value.chat.publication.observedHeadSha,
        completedAt: new Date().toISOString(),
      })
    );
    expect(
      createMaintenanceRebase({ ...value.chat, allowRebase: true }, commands).publicationEvidence()
    ).rejects.toThrow('maintenance_completed_rebase_git_proof_missing');
  });

  it('recovers only a known previous maintenance attempt marker before new work', async () => {
    const value = await conflictingRebase();
    await writeFile(value.marker, watchId);
    await writeFile(path.join(value.checkout, 'user-unfinished.txt'), 'preserve\n');
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    await createMaintenanceRebase({ ...value.chat, recoverableAttemptIds: [] }, commands).recover();
    expect(git(value.checkout, 'branch', '--show-current')).toBe('');
    await createMaintenanceRebase(
      { ...value.chat, recoverableAttemptIds: [watchId] },
      commands
    ).recover();
    expect(git(value.checkout, 'branch', '--show-current')).toBe('feature/fix');
    expect(await readFile(path.join(value.checkout, 'user-unfinished.txt'), 'utf8')).toBe(
      'preserve\n'
    );
  });

  it('rebases a stacked child without replaying its rewritten parent', async () => {
    const value = await fixture();
    git(value.seed, 'checkout', '-b', 'parent', 'main');
    await writeFile(path.join(value.seed, 'parent.txt'), 'old parent\n');
    git(value.seed, 'add', 'parent.txt');
    git(value.seed, 'commit', '-m', 'old parent only');
    git(value.seed, 'push', 'origin', 'parent');
    const oldParent = git(value.seed, 'rev-parse', 'HEAD');
    git(value.seed, 'checkout', '-B', 'feature/fix', 'parent');
    await writeFile(path.join(value.seed, 'conflict.txt'), 'child only\n');
    git(value.seed, 'add', 'conflict.txt');
    git(value.seed, 'commit', '-m', 'child only');
    const child = git(value.seed, 'rev-parse', 'HEAD');
    git(
      value.seed,
      'push',
      `--force-with-lease=refs/heads/feature/fix:${value.chat.publication.observedHeadSha}`,
      'origin',
      'feature/fix'
    );
    git(value.seed, 'checkout', '-B', 'parent', 'main');
    await writeFile(path.join(value.seed, 'parent.txt'), 'new parent\n');
    await writeFile(path.join(value.seed, 'conflict.txt'), 'new base conflict\n');
    git(value.seed, 'add', 'parent.txt', 'conflict.txt');
    git(value.seed, 'commit', '-m', 'rewritten parent only');
    const newParent = git(value.seed, 'rev-parse', 'HEAD');
    git(
      value.seed,
      'push',
      `--force-with-lease=refs/heads/parent:${oldParent}`,
      'origin',
      'parent'
    );
    git(value.checkout, 'fetch', 'origin');
    git(value.checkout, 'checkout', '-B', 'feature/fix', 'origin/feature/fix');
    const chat: MaintenanceChat = {
      ...value.chat,
      allowRebase: true,
      parentCommitSha: oldParent,
      publication: {
        ...value.chat.publication,
        baseRef: 'parent',
        baseSha: newParent,
        observedHeadSha: child,
      },
    };
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    const rebase = createMaintenanceRebase(chat, commands);
    expect(await rebase.start(new AbortController().signal)).toMatchObject({ status: 'conflicts' });
    await writeFile(path.join(value.checkout, 'conflict.txt'), 'new base with child\n');
    git(value.checkout, 'add', 'conflict.txt');
    expect(await rebase.continueRebase(new AbortController().signal)).toMatchObject({
      status: 'completed',
    });
    expect(git(value.checkout, 'log', '--format=%s', `${newParent}..HEAD`)).toBe('child only');
    expect(await readFile(path.join(value.checkout, 'parent.txt'), 'utf8')).toBe('new parent\n');
    expect(() => git(value.checkout, 'merge-base', '--is-ancestor', oldParent, 'HEAD')).toThrow();
    const proof = await rebase.publicationEvidence();
    expect(
      await commands.publish(chat.publication, child, new AbortController().signal, proof)
    ).toMatchObject({
      status: 'published',
      baseSha: newParent,
      ownedRebase: { baseSha: newParent, previousHeadSha: child },
    });
  });
  it('publishes only the observed exact lease and verifies actual remote/base commits', async () => {
    const value = await fixture();
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    const observed = await commands.observe(value.chat.publication);
    await writeFile(path.join(value.checkout, 'fix.txt'), 'repair\n');
    git(value.checkout, 'add', 'fix.txt');
    git(value.checkout, 'commit', '-m', 'repair');
    const head = git(value.checkout, 'rev-parse', 'HEAD');
    const publication = await commands.publish(
      value.chat.publication,
      observed,
      new AbortController().signal
    );
    expect(publication).toMatchObject({
      status: 'published',
      source: 'git',
      observedHeadSha: observed,
      pushedHeadSha: head,
      remoteHeadSha: head,
      pushExitCode: 0,
      exactLease: `refs/heads/feature/fix:${observed}`,
      baseSha: git(value.checkout, 'merge-base', 'HEAD', 'origin/main'),
    });
    expect(git(value.seed, 'ls-remote', '--heads', 'origin', 'feature/fix').split(/\s/)[0]).toBe(
      head
    );
  });

  it('preserves another writer and local repair when the exact lease fails', async () => {
    const value = await fixture();
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    const observed = await commands.observe(value.chat.publication);
    await writeFile(path.join(value.checkout, 'repair.txt'), 'repair\n');
    git(value.checkout, 'add', 'repair.txt');
    git(value.checkout, 'commit', '-m', 'local repair');
    const repair = git(value.checkout, 'rev-parse', 'HEAD');
    await writeFile(path.join(value.seed, 'user.txt'), 'user change\n');
    git(value.seed, 'add', 'user.txt');
    git(value.seed, 'commit', '-m', 'other writer');
    git(value.seed, 'push', 'origin', 'feature/fix');
    const other = git(value.seed, 'rev-parse', 'HEAD');
    expect(
      await commands.publish(value.chat.publication, observed, new AbortController().signal)
    ).toEqual({
      status: 'failed',
      reason: 'maintenance_exact_lease_push_failed_fetch_and_reassess',
    });
    expect(git(value.seed, 'ls-remote', '--heads', 'origin', 'feature/fix').split(/\s/)[0]).toBe(
      other
    );
    expect(git(value.checkout, 'rev-parse', 'HEAD')).toBe(repair);
  });

  it('reports unknown when another real writer changes the remote after a successful push', async () => {
    const value = await fixture();
    await writeFile(path.join(value.checkout, 'repair.txt'), 'repair\n');
    git(value.checkout, 'add', 'repair.txt');
    git(value.checkout, 'commit', '-m', 'repair');
    const commands = createMaintenanceGit({
      directory: value.checkout,
      env,
      runGit: async (args, options) => {
        const result = await runGit(args, options);
        if (args.includes('push') && result.exitCode === 0) {
          git(value.seed, 'fetch', 'origin', 'feature/fix');
          git(value.seed, 'merge', '--ff-only', 'origin/feature/fix');
          await writeFile(path.join(value.seed, 'later-user.txt'), 'later work\n');
          git(value.seed, 'add', 'later-user.txt');
          git(value.seed, 'commit', '-m', 'later user work');
          git(value.seed, 'push', 'origin', 'feature/fix');
        }
        return result;
      },
    });
    expect(
      await commands.publish(
        value.chat.publication,
        value.chat.publication.observedHeadSha,
        new AbortController().signal
      )
    ).toEqual({ status: 'unknown', reason: 'maintenance_remote_head_changed_after_push' });
    expect(git(value.seed, 'ls-remote', '--heads', 'origin', 'feature/fix').split(/\s/)[0]).toBe(
      git(value.seed, 'rev-parse', 'HEAD')
    );
  });

  it('aborts an owned unfinished rebase and preserves unrelated user files', async () => {
    const value = await conflictingRebase();
    await writeFile(value.marker, attemptId);
    await writeFile(path.join(value.checkout, 'user-unfinished.txt'), 'leave me\n');
    expect(
      await createMaintenanceGit({ directory: value.checkout, env }).abortOwnedRebase(attemptId)
    ).toBe('aborted');
    expect(git(value.checkout, 'branch', '--show-current')).toBe('feature/fix');
    expect(git(value.checkout, 'rev-parse', 'HEAD')).toBe(value.chat.publication.observedHeadSha);
    expect(await readFile(path.join(value.checkout, 'user-unfinished.txt'), 'utf8')).toBe(
      'leave me\n'
    );
    expect(
      await access(value.marker).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(
      await createMaintenanceGit({ directory: value.checkout, env }).abortOwnedRebase(attemptId)
    ).toBe('not_owned');
  });

  it('never aborts a user or another attempt rebase', async () => {
    const value = await conflictingRebase();
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    expect(await commands.abortOwnedRebase(attemptId)).toBe('not_owned');
    await writeFile(value.marker, watchId);
    expect(await commands.abortOwnedRebase(attemptId)).toBe('not_owned');
    expect(git(value.checkout, 'branch', '--show-current')).toBe('');
    expect(await readFile(value.marker, 'utf8')).toBe(watchId);
  });

  it('publishes a conflict-only normal rebase onto the fetched base tip', async () => {
    const value = await conflictingRebase();
    await writeFile(value.marker, attemptId);
    await writeFile(path.join(value.checkout, 'conflict.txt'), 'base and feature\n');
    git(value.checkout, 'add', 'conflict.txt');
    git(value.checkout, '-c', 'core.editor=true', 'rebase', '--continue');
    const commands = createMaintenanceGit({ directory: value.checkout, env });
    const publication = await commands.publish(
      value.chat.publication,
      value.chat.publication.observedHeadSha,
      new AbortController().signal
    );
    expect(publication).toMatchObject({
      status: 'published',
      baseSha: git(value.checkout, 'rev-parse', 'origin/main'),
    });
    expect(await commands.abortOwnedRebase(attemptId)).toBe('cleared');
  });
});

describe('maintenance execution publication channel', () => {
  it('keeps publication and result provenance when a later message arrives during the same turn', async () => {
    const value = await fixture();
    const observations: MaintenanceOutcome[] = [];
    const execution = createMaintenanceExecution({
      directory: value.checkout,
      env,
      chat: value.chat,
      onPublication: outcome => {
        observations.push(outcome);
      },
    });
    try {
      const firstPrompt = await execution.prompt('msg_one', 'Repair.');
      const endpoint = firstPrompt.match(
        /http:\/\/127\.0\.0\.1:\d+\/publish\/[a-f0-9-]+\/msg_one/
      )?.[0];
      if (!endpoint) throw new Error('Missing exact-message publication endpoint');
      execution.observe({
        type: 'message',
        message: {
          sessionId: 'ses_fixture',
          id: 'assistant_one',
          role: 'assistant',
          parentMessageId: 'msg_one',
        },
      });
      execution.observe({
        type: 'part',
        part: {
          sessionId: 'ses_fixture',
          messageId: 'assistant_one',
          id: 'first_result',
          kind: 'text',
          text: JSON.stringify({
            version: 1,
            summary: 'Repair verified.',
            changedFiles: [],
            verification: [],
            publication: { status: 'not_attempted', reason: 'Runtime verifies.' },
            problems: [],
            needsInput: null,
          }),
        },
      });
      await execution.prompt('msg_two', 'Also explain it.');
      expect((await fetch(endpoint, { method: 'POST' })).status).toBe(200);
      expect(observations[0]?.messageId).toBe('msg_one');
      const finished = await execution.finish('msg_two');
      expect(finished.resultMessageId).toBe('msg_one');
      expect(finished.publication.status).toBe('not_attempted');
      expect(finished.workspace?.status).toBe('observed');
    } finally {
      await execution.cleanup();
    }
  });
  it('allows old maintenance discussion after the PR branch was deleted', async () => {
    const value = await fixture();
    git(value.seed, 'push', 'origin', '--delete', 'feature/fix');
    const execution = createMaintenanceExecution({
      directory: value.checkout,
      env,
      chat: value.chat,
    });
    try {
      expect(await execution.prompt('msg_discussion', 'Explain the previous repair.')).toContain(
        'Discussion can continue'
      );
      const result = await execution.finish('msg_discussion');
      expect(result.workspace?.status).toBe('unavailable');
      expect(result.publication.status).toBe('not_attempted');
    } finally {
      await execution.cleanup();
    }
  });

  it('observes unchanged published Git state after a cold question answer without another push', async () => {
    const value = await fixture();
    const first = createMaintenanceExecution({ directory: value.checkout, env, chat: value.chat });
    let published: MaintenanceOutcome;
    try {
      const prompt = await first.prompt('msg_question', 'Repair and ask for a decision.');
      const endpoint = prompt.match(/http:\/\/127\.0\.0\.1:\d+\/publish\/[a-f0-9-]+/)?.[0];
      if (!endpoint) throw new Error('Missing publication endpoint');
      await writeFile(path.join(value.checkout, 'repair.txt'), 'repair\n');
      git(value.checkout, 'add', 'repair.txt');
      git(value.checkout, 'commit', '-m', 'repair before question');
      expect((await fetch(endpoint, { method: 'POST' })).status).toBe(200);
      first.observe({
        type: 'message',
        message: { sessionId: 'ses_fixture', id: 'assistant_question', role: 'assistant' },
      });
      first.observe({
        type: 'part',
        part: {
          sessionId: 'ses_fixture',
          messageId: 'assistant_question',
          id: 'question_result',
          kind: 'text',
          text: JSON.stringify({
            version: 1,
            summary: 'Repair published; choose the next action.',
            changedFiles: ['repair.txt'],
            verification: [],
            publication: { status: 'not_attempted', reason: 'Runtime verifies.' },
            problems: [],
            needsInput: 'Continue?',
          }),
        },
      });
      published = await first.finish('msg_question');
      expect(published.publication.status).toBe('published');
    } finally {
      await first.cleanup();
    }
    const answer = createMaintenanceExecution({ directory: value.checkout, env, chat: value.chat });
    try {
      await answer.prompt('msg_answer', 'Keep the published repair.');
      answer.observe({
        type: 'message',
        message: { sessionId: 'ses_fixture', id: 'assistant_answer', role: 'assistant' },
      });
      answer.observe({
        type: 'part',
        part: {
          sessionId: 'ses_fixture',
          messageId: 'assistant_answer',
          id: 'answer_text',
          kind: 'text',
          text: 'The published repair is unchanged.',
        },
      });
      const continued = await answer.finish('msg_answer');
      expect(continued.result).toBeNull();
      expect(continued.publication.status).toBe('not_attempted');
      if (published.publication.status !== 'published')
        throw new Error('Expected actual publication');
      expect(continued.workspace).toMatchObject({
        status: 'observed',
        headSha: published.publication.pushedHeadSha,
        remoteHeadSha: published.publication.remoteHeadSha,
        dirty: false,
      });
    } finally {
      await answer.cleanup();
    }
  });
  it('ignores claimed publication in prose and emits no invented command evidence', async () => {
    const value = await fixture();
    const execution = createMaintenanceExecution({
      directory: value.checkout,
      env,
      chat: value.chat,
    });
    await execution.prompt('msg_one', 'Repair this PR.');
    execution.observe({
      type: 'message',
      message: { sessionId: 'ses_fixture', id: 'assistant', role: 'assistant' },
    });
    execution.observe({
      type: 'part',
      part: {
        sessionId: 'ses_fixture',
        messageId: 'assistant',
        id: 'text',
        kind: 'text',
        text: JSON.stringify({
          version: 1,
          summary: 'Published successfully.',
          changedFiles: [],
          verification: [],
          publication: { status: 'published' },
          problems: [],
          needsInput: null,
        }),
      },
    });
    const result = await execution.finish('msg_one');
    expect(result.publication.status).toBe('not_attempted');
    expect(result.result?.publication.status).toBe('not_attempted');
  });

  it('runs a real agent-invoked local publication and keeps exact message evidence', async () => {
    const value = await fixture();
    const publications: MaintenanceOutcome[] = [];
    const execution = createMaintenanceExecution({
      directory: value.checkout,
      env,
      chat: value.chat,
      onPublication: outcome => {
        publications.push(outcome);
      },
    });
    try {
      const prompt = await execution.prompt('msg_one', 'Repair this PR.');
      const endpoint = prompt.match(/http:\/\/127\.0\.0\.1:\d+\/publish\/[a-f0-9-]+/)?.[0];
      expect(endpoint).toBeDefined();
      if (!endpoint) throw new Error('Missing endpoint');
      await writeFile(path.join(value.checkout, 'repair.txt'), 'fixed\n');
      git(value.checkout, 'add', 'repair.txt');
      git(value.checkout, 'commit', '-m', 'repair');
      const response = await fetch(endpoint, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(publications).toMatchObject([
        { messageId: 'msg_one', publication: { status: 'published', source: 'git' } },
      ]);
      const result = await execution.finish('msg_one');
      expect(result).toMatchObject({
        attemptId,
        messageId: 'msg_one',
        publication: {
          status: 'published',
          source: 'git',
          pushExitCode: 0,
          pushedHeadSha: git(value.checkout, 'rev-parse', 'HEAD'),
        },
      });
    } finally {
      await execution.cleanup();
    }
  });
});
