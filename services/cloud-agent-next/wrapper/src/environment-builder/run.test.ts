import {
  environmentBuildInputSchema,
  environmentBuildEventsSchema,
} from '../../../src/shared/environment-build-protocol.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYSTEM_GIT_CONFIG_ENV } from '../../../src/shared/runtime-environment.js';
import { CONTROL_PLANE_SETUP_EVENTS } from '../../../src/shared/control-plane-protocol.js';
import type {
  EnvironmentBuildEvents,
  EnvironmentBuildInput,
} from '../../../src/shared/environment-build-protocol.js';
import { createRepositoryPreparation } from '../control-plane/repository-preparation.js';
import { directoryHome } from '../control-plane/workspace-home.js';
import { readWorkspaceStamp, writeWorkspaceStamp } from '../control-plane/workspace-stamp.js';
import { gitCredentialRecordPath } from '../control/git-credentials.js';
import { git, runProcess } from '../utils.js';
import { removeBuildCredentials, stopOtherProcesses } from './cleanup.js';
import { createBuildReporter } from './reporter.js';
import { builderSetupEnvironment, runEnvironmentBuild, setupEventLine } from './run.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let root: string;
let origin: string;
let directory: string;
let homeRoot: string;
let tip: string;

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'environment-builder-'));
  origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  directory = path.join(root, 'workspace', 'app');
  homeRoot = path.join(root, 'home');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', origin, author], { env: GIT_ENV, stdio: 'ignore' });
  await fs.writeFile(path.join(author, 'README'), 'one');
  gitIn(author, 'add', 'README');
  gitIn(author, 'commit', '-q', '-m', 'first');
  gitIn(author, 'push', '-q', 'origin', 'HEAD:main');
  tip = gitIn(author, 'rev-parse', 'HEAD');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function buildInput(overrides: Partial<EnvironmentBuildInput> = {}): EnvironmentBuildInput {
  return {
    environmentId: '11111111-1111-4111-8111-111111111111',
    buildId: '22222222-2222-4222-8222-222222222222',
    allocationId: '33333333-3333-4333-8333-333333333333',
    git: { url: pathToFileURL(origin).toString() },
    directory: '/workspace/app',
    commands: [],
    env: { PLAIN: 'plain-value', API_TOKEN: 'secret-canary-value' },
    secretKeys: ['API_TOKEN'],
    deadlineAt: Date.now() + 60_000,
    ...overrides,
  };
}

function harness(
  options: {
    cleanup?: typeof removeBuildCredentials;
    onClone?: (home: string) => Promise<void>;
  } = {}
) {
  const lines: string[] = [];
  const steps: string[] = [];
  let stopped = 0;
  const repository = createRepositoryPreparation({
    runGit: (args, opts) => git(args, opts),
    runSetup: (command, dir, env, onOutput, signal) =>
      runProcess('sh', ['-c', command], {
        cwd: dir,
        env,
        inheritEnv: false,
        ...(signal ? { signal } : {}),
        ...(onOutput ? { onOutput } : {}),
      }),
    sleep: async () => undefined,
    mkdir: dir => fs.mkdir(dir, { recursive: true }).then(() => undefined),
    hasGit: dir =>
      fs.access(path.join(dir, '.git', 'HEAD')).then(
        () => true,
        () => false
      ),
    log: () => undefined,
  });
  const runRepository = options.onClone
    ? {
        ...repository,
        cloneRepository: async (cloneInput: Parameters<typeof repository.cloneRepository>[0]) => {
          await options.onClone?.(directoryHome(directory, homeRoot));
          return repository.cloneRepository({
            ...cloneInput,
            git: { ...cloneInput.git, url: pathToFileURL(origin).toString() },
          });
        },
      }
    : repository;
  const run = (input: EnvironmentBuildInput, signal = new AbortController().signal) =>
    runEnvironmentBuild({
      // The workspace path is fixed in the protocol; tests run it under a temp root.
      input: { ...input, directory } as EnvironmentBuildInput,
      reporter: { setStep: step => steps.push(step), line: line => lines.push(line) },
      repository: runRepository,
      runGit: (args, opts) => git(args, opts),
      stopProcesses: async () => {
        stopped += 1;
      },
      cleanup: options.cleanup ?? removeBuildCredentials,
      writeStamp: (dir, stamp) => writeWorkspaceStamp(dir, true, stamp),
      signal,
      inherited: { PATH: process.env.PATH, ENVIRONMENT_BUILD_CREDENTIAL: 'jwt', HOME: '/root' },
      logPath: undefined,
      homeRoot,
    });
  return { run, lines, steps, stopped: () => stopped };
}

describe('environment build run', () => {
  it('accepts and executes a full 16,000-character environment script', async () => {
    const commands = [
      ('#' + 'x'.repeat(15900) + '\nprintf prepared > long-script-proof').padEnd(16000, ' '),
    ];
    const input = environmentBuildInputSchema.parse(buildInput({ commands }));
    expect(
      environmentBuildInputSchema.safeParse({ ...input, commands: [commands[0] + 'x'] }).success
    ).toBe(false);
    expect(await harness().run(input)).toMatchObject({ outcome: 'ready' });
    expect(await fs.readFile(path.join(directory, 'long-script-proof'), 'utf8')).toBe('prepared');
  });

  it('clones the default branch, pins its commit, runs setup in the fixed home and stamps', async () => {
    const h = harness();
    const result = await h.run(
      buildInput({
        commands: [
          'mkdir -p "$XDG_CACHE_HOME/tool" && echo "$PLAIN" > "$XDG_CACHE_HOME/tool/built"',
          'echo "token is $API_TOKEN"',
        ],
      })
    );

    expect(result).toEqual({
      outcome: 'ready',
      commit: tip,
      branch: 'main',
      setupDurationMs: expect.any(Number),
    });
    const home = directoryHome(directory, homeRoot);
    expect(await fs.readFile(path.join(home, '.cache', 'tool', 'built'), 'utf8')).toBe(
      'plain-value\n'
    );
    expect(await readWorkspaceStamp(directory)).toEqual({
      allocationId: '33333333-3333-4333-8333-333333333333',
      commit: tip,
    });
    expect(h.steps).toEqual(['clone', 'setup', 'cleanup']);
    expect(h.stopped()).toBe(1);
    expect(h.lines.join('\n')).not.toContain('secret-canary-value');
    expect(h.lines).toContain('token is [REDACTED]');
    expect(h.lines).toContain(`Default branch main at ${tip}`);
  });

  it('removes the repository credential before it reports ready', async () => {
    const h = harness();
    const token = 'gho_buildtokencanary1234567890';
    const url = pathToFileURL(origin).toString();
    // A file URL ignores credentials, so the token only appears where cleanup must remove it.
    const result = await h.run(
      buildInput({ git: { url, token }, commands: [`git config credential.helper store`] })
    );

    expect(result.outcome).toBe('ready');
    expect(gitIn(directory, 'remote', 'get-url', 'origin')).toBe(url);
    expect(await fs.readFile(path.join(directory, '.git', 'config'), 'utf8')).not.toContain(token);
    expect(gitIn(directory, 'reflog', '--all')).toBe('');
  });
  it('prepares build authentication', async () => {
    let recordPresentAtClone = false;
    const h = harness({
      onClone: async home => {
        recordPresentAtClone = await fs.access(gitCredentialRecordPath(home)).then(
          () => true,
          () => false
        );
      },
    });
    const result = await h.run(
      buildInput({
        git: {
          url: 'https://github.com/acme/widgets.git',
          token: 'build-token',
          platform: 'github',
        },
      })
    );
    const recordPath = gitCredentialRecordPath(directoryHome(directory, homeRoot));

    expect(result.outcome).toBe('ready');
    expect(recordPresentAtClone).toBe(true);
    expect(
      await fs.access(recordPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it('fails cleanup instead of reporting ready when a credential remains', async () => {
    const h = harness({ cleanup: async () => 'a credential remained in Git metadata' });

    expect(await h.run(buildInput())).toEqual({
      outcome: 'failed',
      step: 'cleanup',
      reason: 'cleanup_failed',
      detail: 'a credential remained in Git metadata',
    });
    expect(await readWorkspaceStamp(directory)).toBeNull();
  });
  it('reports an unavailable cleanup', async () => {
    const home = directoryHome(directory, homeRoot);
    const recordPath = gitCredentialRecordPath(home);
    await fs.mkdir(path.join(recordPath, 'child'), { recursive: true });

    expect(
      await removeBuildCredentials({
        git: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        directory,
        home,
        bareUrl: 'https://github.com/acme/widgets.git',
        canaries: [],
        logPath: undefined,
      })
    ).toBe('build Git credential record could not be removed');
  });

  it('reports a failing or timed-out setup command with its step', async () => {
    const h = harness();
    expect(await h.run(buildInput({ commands: ['exit 3'] }))).toEqual({
      outcome: 'failed',
      step: 'setup',
      reason: 'setup_failed',
    });
    expect(h.lines.some(line => line.includes('Setup command 1 failed (exit 3)'))).toBe(true);
  });

  it('reports a clone failure for an unreachable repository', async () => {
    const h = harness();
    expect(
      await h.run(
        buildInput({ git: { url: pathToFileURL(path.join(root, 'missing.git')).toString() } })
      )
    ).toMatchObject({ outcome: 'failed', step: 'clone', reason: 'clone_failed' });
  });

  it('stops a canceled build without running further setup', async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.run(
      buildInput({ commands: ['sleep 5', 'touch should-not-run'] }),
      controller.signal
    );
    setTimeout(() => controller.abort(), 200);

    expect(await result).toMatchObject({ outcome: 'failed', reason: 'canceled' });
    expect(await fs.stat(path.join(directory, 'should-not-run')).catch(() => null)).toBeNull();
  });
});

describe('builder setup environment', () => {
  it('drops the build credential and runtime names and keeps caches under the fixed home', () => {
    const env = builderSetupEnvironment({
      inherited: {
        PATH: '/bin',
        ENVIRONMENT_BUILD_CREDENTIAL: 'jwt',
        KILO_RUNTIME_CLI_PATH: '/opt/kilo',
        HOME: '/root',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'store',
      },
      vars: {
        FOO: 'bar',
        XDG_CACHE_HOME: '/elsewhere',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'store',
      },
      home: '/home/abc',
      directory: '/workspace/app',
    });

    expect(env).toEqual({
      PATH: '/bin',
      FOO: 'bar',
      PWD: '/workspace/app',
      HOME: '/home/abc',
      XDG_DATA_HOME: '/home/abc/.local/share',
      XDG_CONFIG_HOME: '/home/abc/.config',
      XDG_CACHE_HOME: '/home/abc/.cache',
      XDG_STATE_HOME: '/home/abc/.local/state',
      ...SYSTEM_GIT_CONFIG_ENV,
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('renders setup events without repeating command text', () => {
    expect(
      setupEventLine({
        type: CONTROL_PLANE_SETUP_EVENTS.started,
        properties: { command: 1, commandCount: 2 },
      })
    ).toBe('▶ Setup command 1 of 2');
  });
});

describe('builder process stop', () => {
  it('refuses to signal processes outside a builder container', async () => {
    const refusal = await stopOtherProcesses({ pid: 4242, kill: () => undefined }).catch(
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('Refusing to stop processes');
  });

  it('terminates then kills every other process when it is PID 1', async () => {
    const signals: string[] = [];
    await stopOtherProcesses({
      pid: 1,
      kill: (target, signal) => signals.push(`${target}:${signal}`),
      sleep: async () => undefined,
    });
    expect(signals).toEqual(['-1:SIGTERM', '-1:SIGKILL']);
  });
});

describe('build reporter', () => {
  it('delivers short-line output in valid batches without losing later lines', async () => {
    const received: string[] = [];
    const reporter = createBuildReporter({
      client: {
        events: async batch => {
          const parsed = environmentBuildEventsSchema.parse(batch);
          received.push(...(parsed.logs ?? []));
          return { action: 'continue' };
        },
      },
      intervalMs: 60_000,
      onCancel: () => undefined,
      log: () => undefined,
    });
    const lines = Array.from({ length: 650 }, (_, i) => `line ${i}`);
    lines.forEach(line => reporter.line(line));
    await reporter.flush();
    expect(received).toEqual(lines.slice(0, 512));
    await reporter.flush();
    expect(received).toEqual(lines);
  });

  it('sends the step once, batches lines with a sequence and retains them after a failure', async () => {
    const batches: EnvironmentBuildEvents[] = [];
    let fail = true;
    const reporter = createBuildReporter({
      client: {
        events: async batch => {
          if (fail) {
            fail = false;
            throw new Error('offline');
          }
          batches.push(batch);
          return { action: 'continue' };
        },
      },
      intervalMs: 60_000,
      onCancel: () => undefined,
      log: () => undefined,
    });
    reporter.setStep('setup');
    reporter.line('one');
    await reporter.flush();
    reporter.line('two');
    await reporter.flush();
    await reporter.flush();

    expect(batches).toEqual([
      { sequence: 1, step: 'setup', logs: ['one', 'two'] },
      { sequence: 2 },
    ]);
  });

  it('aborts the build on a cancel reply', async () => {
    let canceled = false;
    const reporter = createBuildReporter({
      client: { events: async () => ({ action: 'cancel' }) },
      intervalMs: 60_000,
      onCancel: () => {
        canceled = true;
      },
      log: () => undefined,
    });
    await reporter.flush();
    expect(canceled).toBe(true);
  });
});
