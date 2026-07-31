import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();

function executable(file: string, contents: string): void {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function gitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-workflow-script-'));
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.env.local\n');
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'base']);
  return root;
}

test('baseline detects changes to an explicitly included ignored file', () => {
  const root = gitRepo();
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-baseline-test-'));
  fs.rmdirSync(baseline);
  const script = path.join(repoRoot, '.kilo_workflow/baseline.sh');
  try {
    fs.writeFileSync(path.join(root, '.env.local'), 'before\n');
    execFileSync(script, ['snapshot', root, baseline, '--include', '.env.local']);
    fs.writeFileSync(path.join(root, '.env.local'), 'after\n');
    const result = spawnSync(script, ['check', root, baseline, '--include', '.env.local'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /DIVERGED included files/);
    assert.ok(fs.existsSync(baseline), 'a mismatch should retain its evidence');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(baseline, { recursive: true, force: true });
  }
});

test('a successful baseline check consumes the snapshot for the next round', () => {
  const root = gitRepo();
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-baseline-test-'));
  fs.rmdirSync(baseline);
  const script = path.join(repoRoot, '.kilo_workflow/baseline.sh');
  try {
    execFileSync(script, ['snapshot', root, baseline]);
    assert.match(execFileSync(script, ['check', root, baseline], { encoding: 'utf8' }), /OK/);
    assert.ok(!fs.existsSync(baseline));
    assert.doesNotThrow(() => execFileSync(script, ['snapshot', root, baseline]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(baseline, { recursive: true, force: true });
  }
});

test('slice check rejects an implementer that changed nothing', () => {
  const root = gitRepo();
  const output = path.join(os.tmpdir(), `kilo-slice-${process.pid}-${Date.now()}.diff`);
  const script = path.join(repoRoot, '.kilo_workflow/slice-diff.sh');
  try {
    const snapshot = execFileSync(script, [root, output, '--', 'file.txt'], {
      encoding: 'utf8',
    }).trim();
    const result = spawnSync(
      script,
      ['--check', 'implementer', snapshot, root, output, '--', 'file.txt'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /without changing the owned paths/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { force: true });
  }
});

test('role dispatches allocate distinct artifacts and verifier scratch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-dispatch-test-'));
  const bin = path.join(root, 'bin');
  const scratch = path.join(root, 'scratch');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(scratch);
  fs.mkdirSync(home);
  const tmux = path.join(bin, 'tmux');
  const tmuxLog = path.join(root, 'tmux.log');
  const handoff = path.join(root, 'handoff.md');
  fs.writeFileSync(handoff, 'Review this.\n');
  fs.writeFileSync(
    tmux,
    '#!/bin/sh\n' +
      'if [ "$1" = display-message ]; then echo caller; fi\n' +
      'if [ "$1" = new-window ]; then printf "%s\\n" "$*" >> "$TMUX_LOG"; echo @42; fi\n' +
      'exit 0\n'
  );
  fs.chmodSync(tmux, 0o755);
  // The verifier refuses a dirty worktree, so dispatch targets a minimal
  // clean repo, never the live one (which may legitimately be dirty).
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.kilo/agent'), { recursive: true });
  for (const role of ['implementer', 'plan-reviewer', 'impl-reviewer', 'e2e-verifier']) {
    fs.writeFileSync(path.join(wt, `.kilo/agent/${role}.md`), '# role\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['add', '.'], { cwd: wt });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: wt,
  });
  const script = path.join(repoRoot, '.kilo_workflow/dispatch-role.sh');
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    TMUX_LOG: tmuxLog,
    TMUX_PANE: '%1',
  };
  const dispatch = (role = 'implementer', extraArgs: string[] = []) =>
    execFileSync(
      script,
      [role, 'test-abcd', 'r1', wt, scratch, 'Exercise the role.', ...extraArgs],
      {
        cwd: root,
        encoding: 'utf8',
        env,
      }
    ).trim();
  try {
    const first = dispatch();
    fs.writeFileSync(path.join(home, '.cache/kilo-launch-gate/last'), '0\n');
    const second = dispatch();
    assert.notEqual(first, second);
    assert.ok(fs.existsSync(`${first}.meta`));
    assert.ok(fs.existsSync(`${second}.meta`));
    assert.match(fs.readFileSync(`${first}.meta`, 'utf8'), /^tmux=@42$/m);
    fs.writeFileSync(path.join(home, '.cache/kilo-launch-gate/last'), '0\n');
    // Uncommitted state in the target worktree blocks only the verifier.
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'uncommitted\n');
    assert.throws(() => dispatch('e2e-verifier'), /must be fully committed/);
    dispatch('implementer');
    fs.rmSync(path.join(wt, 'dirty.txt'));
    const verifier = dispatch('e2e-verifier');
    const verifierScratch = fs
      .readFileSync(`${verifier}.meta`, 'utf8')
      .match(/^scratch=(.*)$/m)?.[1];
    assert.ok(verifierScratch?.startsWith(`${scratch}/e2e-r1-`));
    assert.ok(fs.existsSync(verifierScratch));
    fs.writeFileSync(path.join(home, '.cache/kilo-launch-gate/last'), '0\n');
    dispatch('implementer', ['--file', 'handoff.md']);
    const tmuxCommands = fs.readFileSync(tmuxLog, 'utf8');
    assert.ok(tmuxCommands.includes(`--file ${path.join(fs.realpathSync(root), 'handoff.md')}`));
    assert.match(tmuxCommands, /--auto/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interactive launches return a stable tmux window id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-interactive-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const log = path.join(root, 'interactive.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = display-message ]; then echo caller; fi\n' +
      'if [ "$1" = new-window ]; then echo @77; fi\n' +
      'exit 0\n'
  );
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  for (const command of ['tmux', 'sleep']) fs.chmodSync(path.join(bin, command), 0o755);
  try {
    const output = execFileSync(
      path.join(repoRoot, '.kilo_workflow/launch-interactive.sh'),
      ['test-abcd-planner', repoRoot, '--log', log, 'kilo', '--interactive'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          TMUX_PANE: '%1',
        },
      }
    ).trim();
    assert.equal(output, '@77');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('await-role accepts only a completed role-specific verdict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-await-role-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  for (const command of ['tmux', 'sleep']) fs.chmodSync(path.join(bin, command), 0o755);
  const script = path.join(repoRoot, '.kilo_workflow/await-role.sh');
  const run = (
    name: string,
    options: {
      exit?: boolean;
      log: string;
      meta?: string;
    }
  ) => {
    const log = path.join(root, `${name}.log`);
    fs.writeFileSync(log, options.log);
    if (options.exit !== false) fs.writeFileSync(`${log}.exit`, '0\n');
    if (options.meta !== undefined) fs.writeFileSync(`${log}.meta`, options.meta);
    return spawnSync(script, [log, '--timeout', '0', '--stall', '999'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  };
  try {
    const done = run('done', {
      log: 'No findings.\nEXITCODE=0\n',
      meta: 'role=impl-reviewer\nmode=verify\ntmux=@1\n',
    });
    assert.equal(done.status, 0);
    assert.equal(done.stdout.trim(), 'DONE No findings.');

    const invalid = [
      run('implementer-wrong-sentinel', {
        log: 'No findings.\nEXITCODE=0\n',
        meta: 'role=implementer\nmode=verify\ntmux=@2\n',
      }),
      run('repro-wrong-sentinel', {
        log: 'VERIFICATION PASSED.\nEXITCODE=0\n',
        meta: 'role=e2e-verifier\nmode=repro\ntmux=@3\n',
      }),
      run('zero-findings', {
        log: 'FINDINGS: 0\nEXITCODE=0\n',
        meta: 'role=impl-reviewer\nmode=verify\ntmux=@4\n',
      }),
      run('corrupt-meta', {
        log: 'No findings.\nEXITCODE=0\n',
        meta: 'role=unknown\nmode=verify\ntmux=@5\n',
      }),
      run('missing-meta', {
        log: 'No findings.\nEXITCODE=0\n',
      }),
      run('dead-target', {
        exit: false,
        log: 'still working\n',
        meta: 'role=impl-reviewer\nmode=verify\ntmux=@6\n',
      }),
    ];
    for (const result of invalid) {
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stdout, /^VOID /);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reviewer ranking aborts when commit history lookup fails', () => {
  const root = gitRepo();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(
    gh,
    '#!/bin/sh\n[ "$1" = api ] && exit 1\n[ "$1" = pr ] && [ "$2" = list ] && exit 0\nexit 0\n'
  );
  fs.chmodSync(gh, 0o755);
  try {
    const result = spawnSync(
      path.join(repoRoot, '.kilo_workflow/pick-reviewers.sh'),
      ['Kilo-Org/cloud', 'requester', 'file.txt'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to find PRs for commit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reviewer ranking refuses files that do not exist in the repo', () => {
  const root = gitRepo();
  try {
    const result = spawnSync(
      path.join(repoRoot, '.kilo_workflow/pick-reviewers.sh'),
      ['Kilo-Org/cloud', 'requester', 'no-such-file.txt'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run in the changed repo/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launch gate explains how to repair an unprepared worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-launch-gate-test-'));
  const workflow = path.join(root, '.kilo_workflow');
  fs.mkdirSync(workflow);
  const script = path.join(workflow, 'launch-gate.sh');
  fs.copyFileSync(path.join(repoRoot, '.kilo_workflow/launch-gate.sh'), script);
  fs.chmodSync(script, 0o755);
  try {
    const result = spawnSync(script, [], {
      encoding: 'utf8',
      env: { ...process.env, HOME: path.join(root, 'home') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /prepare the cloud worktree/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E lifecycle scripts take, start, stop, and free one slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-lifecycle-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const commandLog = path.join(root, 'commands.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = display-message ]; then echo test-owner; exit 0; fi\n' +
      'if [ "$1" = has-session ]; then [ "$3" = "=test-owner" ]; exit; fi\n' +
      'if [ "$1" = list-sessions ]; then echo test-owner; exit 0; fi\n' +
      'exit 1\n'
  );
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${repoRoot}'\n`);
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/bin/sh\nprintf "%s: %s\\n" "$PWD" "$*" >> "$COMMAND_LOG"\n' +
      'if [ "$2" = "dev:status" ]; then\n' +
      '  printf \'%s\\n\' \'{"services":[{"name":"mobile","status":"up"},{"name":"nextjs","status":"up"},{"name":"cloudflare-session-ingest","status":"up"},{"name":"web","status":"up"}]}\'\n' +
      'fi\n'
  );
  for (const command of ['tmux', 'git', 'pnpm']) fs.chmodSync(path.join(bin, command), 0o755);
  const env = {
    ...process.env,
    COMMAND_LOG: commandLog,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: path.join(root, 'tmp'),
    TMUX_PANE: '%1',
  };
  try {
    const run = (script: string, args: string[] = [], cwd: string = repoRoot) =>
      spawnSync(path.join(repoRoot, '.kilo_workflow', script), args, {
        cwd,
        encoding: 'utf8',
        env,
      });
    // Starting a resource before taking a slot refuses with the remedy.
    const early = run('e2e-start-resource.sh', ['stack', 'mobile']);
    assert.equal(early.status, 1);
    assert.match(early.stderr, /take a slot first/);
    assert.equal(run('e2e-take-slot.sh').status, 0);
    // Invoked from a foreign CWD, repo wrappers still run in the script's repo.
    assert.equal(run('e2e-start-resource.sh', ['stack', 'mobile', 'web'], os.tmpdir()).status, 0);
    assert.equal(run('e2e-stop-resource.sh', ['stack'], os.tmpdir()).status, 0);
    assert.match(run('e2e-slot-status.sh').stdout, /slot-1: test-owner/);
    // The old API was `e2e-slot.sh acquire <session>` — a forwarded session
    // name must fail loudly, never acquire under the wrong owner.
    const badTake = run('e2e-take-slot.sh', ['my-session']);
    assert.equal(badTake.status, 1);
    assert.match(badTake.stderr, /takes no session name/);
    const badStatus = run('e2e-slot-status.sh', ['bogus']);
    assert.equal(badStatus.status, 1);
    assert.match(badStatus.stderr, /takes no arguments/);
    const badFree = run('e2e-free-slot.sh', ['bogus']);
    assert.equal(badFree.status, 1);
    assert.match(badFree.stderr, /takes no arguments/);
    assert.equal(run('e2e-free-slot.sh').status, 0);
    assert.match(run('e2e-slot-status.sh').stdout, /0\/3 held/);
    assert.equal(
      fs.readFileSync(commandLog, 'utf8'),
      `${repoRoot}: dev:env -y cloudflare-session-ingest\n` +
        `${repoRoot}: dev:start --no-attach --reuse-running mobile web\n` +
        `${repoRoot}: drizzle migrate\n` +
        `${repoRoot}: -s dev:status --json\n` +
        `${repoRoot}: dev:stop\n`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E status reclaims dead slot owners and reports unaccounted stacks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-status-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'dead-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), path.join(root, 'dead-abcd'));
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = has-session ]; then exit 1; fi\n' +
      'if [ "$1" = list-sessions ]; then printf "live-owner\\nkilo-dev-orphan-abcd\\n"; exit 0; fi\n' +
      'exit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  try {
    const result = spawnSync(path.join(repoRoot, '.kilo_workflow/e2e-slot-status.sh'), [], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(slot));
    assert.match(result.stderr, /reclaimed slot-1 from dead session dead-owner/);
    assert.match(result.stdout, /UNACCOUNTED stack: kilo-dev-orphan-abcd/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reap removes a stale ownerless slot left by an interrupted acquire', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-orphan-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(slot, { recursive: true });
  const old = new Date(Date.now() - 61_000);
  fs.utimesSync(slot, old, old);
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nif [ "$1" = list-sessions ]; then exit 0; fi\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  try {
    const result = spawnSync(path.join(repoRoot, '.kilo_workflow/e2e-slot-status.sh'), [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: root,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(slot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR gate rejects a bot comment older than the current head', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-pr-gate-test-'));
  const workflow = path.join(root, '.kilo_workflow');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(workflow);
  fs.mkdirSync(bin);
  for (const script of ['pr-gate.sh', 'pr-threads.sh']) {
    fs.copyFileSync(path.join(repoRoot, '.kilo_workflow', script), path.join(workflow, script));
    fs.chmodSync(path.join(workflow, script), 0o755);
  }
  executable(
    path.join(bin, 'gh'),
    `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  printf '%s\n' '{"headRefOid":"abc","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test","conclusion":"SUCCESS"}],"assignees":[{"login":"igor"}],"labels":[]}'
elif [ "$1" = api ]; then
  case "$2" in
    repos/Kilo-Org/cloud/commits/abc) printf '%s\n' '2026-01-02T00:00:00Z' ;;
    repos/Kilo-Org/cloud/issues/1/comments?*) printf '%s\n' '[]' ;;
    graphql) printf '%s\n' '{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}' ;;
    *) exit 1 ;;
  esac
else
  exit 1
fi
`
  );
  try {
    const result = spawnSync(path.join(workflow, 'pr-gate.sh'), ['Kilo-Org/cloud', '1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /bot comments after head commit: NONE/);
    assert.match(result.stdout, /no kilo-code-bot summary/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR gate sees a bot summary edited after the current head', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-pr-gate-edit-test-'));
  const workflow = path.join(root, '.kilo_workflow');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(workflow);
  fs.mkdirSync(bin);
  for (const script of ['pr-gate.sh', 'pr-threads.sh']) {
    fs.copyFileSync(path.join(repoRoot, '.kilo_workflow', script), path.join(workflow, script));
    fs.chmodSync(path.join(workflow, script), 0o755);
  }
  executable(
    path.join(bin, 'gh'),
    `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  printf '%s\n' '{"headRefOid":"abc","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test","conclusion":"SUCCESS"}],"assignees":[{"login":"igor"}],"labels":[]}'
elif [ "$1" = api ]; then
  case "$2" in
    repos/Kilo-Org/cloud/commits/abc) printf '%s\n' '2026-01-02T00:00:00Z' ;;
    repos/Kilo-Org/cloud/issues/1/comments?*) printf '%s\n' '[{"user":{"login":"kilo-code-bot[bot]"},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:10:00Z","body":"Recommendation: Merge"}]' ;;
    graphql) printf '%s\n' '{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}' ;;
    *) exit 1 ;;
  esac
else
  exit 1
fi
`
  );
  try {
    const result = spawnSync(path.join(workflow, 'pr-gate.sh'), ['Kilo-Org/cloud', '1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /GATE OK/);
    assert.match(result.stdout, /kilo-code-bot\[bot\] @ 2026-01-02T00:10:00Z/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR thread listing fails when a later page cannot be read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-pr-threads-test-'));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  fs.mkdirSync(bin);
  executable(
    path.join(bin, 'gh'),
    `#!/bin/sh
n=$(cat "$CALLS" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s\n' "$n" > "$CALLS"
[ "$n" -eq 1 ] || exit 19
printf '%s\n' '{"pageInfo":{"hasNextPage":true,"endCursor":"next"},"nodes":[]}'
`
  );
  try {
    const result = spawnSync(
      path.join(repoRoot, '.kilo_workflow/pr-threads.sh'),
      ['unresolved', 'Kilo-Org/cloud', '1'],
      {
        encoding: 'utf8',
        env: { ...process.env, CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
      }
    );
    assert.equal(result.status, 19);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR thread close is repository-bound and idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-pr-close-test-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'gh.log');
  const gh = path.join(bin, 'gh');
  fs.mkdirSync(bin);
  executable(
    gh,
    `#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  *resolveReviewThread*) printf '%s\n' true ;;
  *node\\(id:*) printf '%s\n' '{"data":{"node":{"pullRequest":{"number":1},"repository":{"nameWithOwner":"Kilo-Org/other"},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"databaseId":7,"body":"(bot) fixed"}]}}}}' ;;
  *) exit 1 ;;
esac
`
  );
  const run = () =>
    spawnSync(
      path.join(repoRoot, '.kilo_workflow/pr-threads.sh'),
      ['close', 'Kilo-Org/cloud', 'thread', 'fixed'],
      {
        encoding: 'utf8',
        env: { ...process.env, GH_LOG: log, PATH: `${bin}:${process.env.PATH}` },
      }
    );
  try {
    const foreign = run();
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /belongs to Kilo-Org\/other/);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /resolveReviewThread|\/replies/);

    fs.writeFileSync(
      gh,
      fs.readFileSync(gh, 'utf8').replace('"Kilo-Org/other"', '"Kilo-Org/cloud"')
    );
    fs.writeFileSync(log, '');
    const retry = run();
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /reply already posted/);
    assert.match(retry.stdout, /resolved thread/);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /\/replies/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interactive monitor distinguishes completed, blocked, and dead sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-await-interactive-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  executable(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n');
  executable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  const run = (scratch: string) =>
    spawnSync(path.join(repoRoot, '.kilo_workflow/await-interactive.sh'), ['@1', scratch], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  try {
    assert.deepEqual(
      [run(path.join(root, 'gone')).status, run(path.join(root, 'gone')).stdout.trim()],
      [0, 'COMPLETED']
    );
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'final-report.md'), 'blocked\n');
    const blockedResult = run(blocked);
    assert.equal(blockedResult.status, 5);
    assert.equal(blockedResult.stdout.trim(), `BLOCKED ${blocked}/final-report.md`);
    const dead = path.join(root, 'dead');
    fs.mkdirSync(dead);
    const deadResult = run(dead);
    assert.equal(deadResult.status, 2);
    assert.equal(deadResult.stdout.trim(), 'DEAD');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('section setup removes its worktree and branch when preparation fails', () => {
  const root = gitRepo();
  const remote = path.join(os.tmpdir(), `kilo-init-remote-${process.pid}-${Date.now()}.git`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-init-home-'));
  const bin = path.join(home, 'bin');
  const workflow = path.join(root, '.kilo_workflow');
  fs.mkdirSync(bin);
  fs.mkdirSync(workflow);
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/init-section.sh'),
    path.join(workflow, 'init-section.sh')
  );
  fs.chmodSync(path.join(workflow, 'init-section.sh'), 0o755);
  executable(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 9\n');
  try {
    execFileSync('git', ['clone', '--bare', root, remote]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
    const result = spawnSync(path.join(workflow, 'init-section.sh'), ['cleanup'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 9);
    assert.equal(
      execFileSync('git', ['-C', root, 'branch', '--format=%(refname:short)'], {
        encoding: 'utf8',
      }).trim(),
      'main'
    );
    assert.equal(
      execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
      }).match(/^worktree /gm)?.length,
      1
    );
    assert.deepEqual(fs.readdirSync(path.join(home, 'Projects/.worktrees')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('steer requires a new submitted echo for an identical message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-steer-test-'));
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  fs.mkdirSync(bin);
  fs.writeFileSync(state, '1\n');
  executable(
    path.join(bin, 'tmux'),
    `#!/bin/sh
case "$1" in
  display-message) echo node ;;
  capture-pane)
    echo '› repeat me'
    [ "$(cat "$STATE")" -eq 2 ] && echo '› repeat me'
    ;;
  send-keys) echo 2 > "$STATE" ;;
esac
`
  );
  executable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  try {
    const result = spawnSync(path.join(repoRoot, '.kilo_workflow/steer.sh'), ['@1', 'repeat me'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE: state },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makePnpmStub(bin: string, commandLog: string): void {
  executable(
    path.join(bin, 'pnpm'),
    '#!/bin/sh\n' +
      `main="\$1"\n` +
      `sub="\$2"\n` +
      `if [ "\$main" = "-s" ]; then\n` +
      `  main="\$2"\n` +
      `  sub="\$3"\n` +
      `fi\n` +
      `printf '%s: %s\\n' "\$PWD" "\$*" >> "${commandLog.replace(/"/g, '\\"')}"\n` +
      `case "\$main" in\n` +
      `  dev:env|dev:start|drizzle) ;;\n` +
      `  dev:status)\n` +
      `    printf '%s\\n' '{"services":[{"name":"mobile","status":"up"},{"name":"nextjs","status":"up"},{"name":"cloudflare-session-ingest","status":"up"},{"name":"cloud-agent-next","status":"up"},{"name":"kiloclaw","status":"up"},{"name":"event-service","status":"up"}]}'\n` +
      `    ;;\n` +
      `  dev:mobile:simulator)\n` +
      `    printf '{"device":{"id":"UDID-123"},"worktreeRoot":"%s"}\\n' "\$PWD"\n` +
      `    ;;\n` +
      `  dev:mobile:ios)\n` +
      `    if [ -n "\$IOS_BUILD_FAIL" ]; then exit 1; fi\n` +
      `    ;;\n` +
      `  dev:mobile:android)\n` +
      `    case "\$sub" in\n` +
      `      emulator-start)\n` +
      `        mkdir -p "\$TMPDIR/kilo-mobile-android-emulators"\n` +
      `        printf '{\\n  "serial": "emulator-5554",\\n  "pid": 123,\\n  "log": "/tmp/log",\\n  "worktreeRoot": "%s"\\n}\\n' "\$PWD" > "\$TMPDIR/kilo-mobile-android-emulators/$(basename "\$PWD").json"\n` +
      `        ;;\n` +
      `      adb)\n` +
      `        [ "\$BOOT_COMPLETED" = "1" ] && echo 1 || echo 0\n` +
      `        ;;\n` +
      `      claim) ;;\n` +
      `      build)\n` +
      `        if [ -n "\$ANDROID_BUILD_FAIL" ]; then exit 1; fi\n` +
      `        ;;\n` +
      `    esac\n` +
      `    ;;\n` +
      `esac\n`
  );
}

function makeNpxStub(bin: string, commandLog: string): void {
  executable(
    path.join(bin, 'npx'),
    '#!/bin/sh\n' +
      `printf '%s: %s\\n' "\$PWD" "\$*" >> "${commandLog.replace(/"/g, '\\"')}"\n` +
      `if [ "\$1" = "expo" ] && [ "\$2" = "prebuild" ]; then\n` +
      `  platform="\$4"\n` +
      `  if [ "\$platform" = "ios" ]; then\n` +
      `    mkdir -p ios/Kilo.xcworkspace\n` +
      `  elif [ "\$platform" = "android" ]; then\n` +
      `    mkdir -p android\n` +
      `    touch android/build.gradle\n` +
      `  fi\n` +
      `  if [ -n "\$DIRTY_PREBUILD" ]; then\n` +
      `    touch dirty-prebuild.txt\n` +
      `  fi\n` +
      `fi\n`
  );
}

test('E2E status enumerates iOS booted devices and Android emulators', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-device-enum-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'live-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), path.join(root, 'covered-abcd'));
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = has-session ]; then exit 0; fi\n' +
      'if [ "$1" = list-sessions ]; then printf "kilo-dev-covered-abcd\n"; exit 0; fi\n' +
      'exit 1\n'
  );
  fs.writeFileSync(
    path.join(bin, 'xcrun'),
    '#!/bin/sh\n' +
      'if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "booted" ]; then\n' +
      '  printf "iPhone 17 (BOOTED-UDID) (Booted)\\n"\n' +
      '  printf "iPhone Claimed (CLAIMED-UDID) (Booted)\\n"\n' +
      'fi\n'
  );
  fs.writeFileSync(
    path.join(bin, 'adb'),
    '#!/bin/sh\n' +
      'printf "List of devices attached\\nemulator-5554\\tdevice\\nphysical-123\\tdevice\\n"\n'
  );
  for (const command of ['tmux', 'xcrun', 'adb']) fs.chmodSync(path.join(bin, command), 0o755);
  try {
    const result = spawnSync(path.join(repoRoot, '.kilo_workflow/e2e-slot-status.sh'), [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UNACCOUNTED booted device: BOOTED-UDID/);
    assert.match(result.stdout, /UNACCOUNTED booted emulator: emulator-5554/);
    assert.doesNotMatch(result.stdout, /UNACCOUNTED booted emulator: physical-123/);
    // Claimed iOS device is covered by the existing claim check, not device enum.
    fs.mkdirSync(path.join(root, 'tmp', 'kilo-mobile-simulator-claims'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'tmp', 'kilo-mobile-simulator-claims', 'CLAIMED-UDID.json'),
      JSON.stringify({ worktreeRoot: path.join(root, 'covered-abcd') })
    );
    const claimed = spawnSync(path.join(repoRoot, '.kilo_workflow/e2e-slot-status.sh'), [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
      },
    });
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.match(claimed.stdout, /UNACCOUNTED booted device: BOOTED-UDID/);
    assert.doesNotMatch(claimed.stdout, /UNACCOUNTED booted device: CLAIMED-UDID/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E status reports claimed-but-dead devices and suppresses footer on findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-dead-device-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  const covered = path.join(root, 'covered-abcd');
  fs.mkdirSync(bin);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'live-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), covered);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = has-session ]; then exit 0; fi\n' +
      'if [ "$1" = list-sessions ]; then printf "kilo-dev-covered-abcd\n"; exit 0; fi\n' +
      'exit 1\n'
  );
  fs.writeFileSync(
    path.join(bin, 'xcrun'),
    '#!/bin/sh\n' +
      'if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "booted" ]; then\n' +
      '  printf "iPhone 17 (ALIVE-UDID) (Booted)\\n"\n' +
      'fi\n'
  );
  fs.writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\nexit 0\n');
  for (const command of ['tmux', 'xcrun', 'adb']) fs.chmodSync(path.join(bin, command), 0o755);
  fs.mkdirSync(path.join(root, 'tmp', 'kilo-mobile-simulator-claims'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tmp', 'kilo-mobile-simulator-claims', 'DEAD-UDID.json'),
    JSON.stringify({ worktreeRoot: covered })
  );
  try {
    const result = spawnSync(path.join(repoRoot, '.kilo_workflow/e2e-slot-status.sh'), [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DEAD device: DEAD-UDID claimed by .*covered-abcd.* \(slot held\)/);
    assert.doesNotMatch(result.stdout, /no unaccounted known resources/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E status prints all-clear footer only when there are zero findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-clear-footer-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'live-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), path.join(root, 'covered-abcd'));
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = has-session ]; then exit 0; fi\n' +
      'if [ "$1" = list-sessions ]; then printf "kilo-dev-covered-abcd\n"; exit 0; fi\n' +
      'exit 1\n'
  );
  fs.writeFileSync(path.join(bin, 'xcrun'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\nexit 0\n');
  for (const command of ['tmux', 'xcrun', 'adb']) fs.chmodSync(path.join(bin, command), 0o755);
  try {
    const result = spawnSync(path.join(repoRoot, '.kilo_workflow/e2e-slot-status.sh'), [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no unaccounted known resources/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E status reports Android DEAD once when adb sees no devices', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-android-dead-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  const covered = path.join(root, 'covered-abcd');
  fs.mkdirSync(bin);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'live-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), covered);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = has-session ]; then exit 0; fi\n' +
      'if [ "$1" = list-sessions ]; then printf "kilo-dev-covered-abcd\n"; exit 0; fi\n' +
      'exit 1\n'
  );
  fs.writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\nprintf "List of devices attached\\n"\n');
  for (const command of ['tmux', 'adb']) fs.chmodSync(path.join(bin, command), 0o755);
  fs.mkdirSync(path.join(root, 'tmp', 'kilo-mobile-android-claims'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tmp', 'kilo-mobile-android-claims', 'emulator-5554.json'),
    JSON.stringify({ serial: 'emulator-5554', worktreeRoot: covered })
  );
  fs.mkdirSync(path.join(root, 'tmp', 'kilo-mobile-android-emulators'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tmp', 'kilo-mobile-android-emulators', 'covered-abcd.json'),
    JSON.stringify({ serial: 'emulator-5554', worktreeRoot: covered })
  );
  try {
    const result = spawnSync(path.join(repoRoot, '.kilo_workflow/e2e-slot-status.sh'), [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const deadMatches = result.stdout.match(/DEAD device: emulator-5554/g);
    assert.equal(deadMatches?.length, 1, `expected one DEAD line, got: ${result.stdout}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E acquire wait announces holders before the first retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-acquire-wait-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const state = path.join(home, '.cache/kilo-e2e-slots');
  fs.mkdirSync(bin);
  fs.mkdirSync(state, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    const slot = path.join(state, `slot-${i}`);
    fs.mkdirSync(slot);
    fs.writeFileSync(path.join(slot, 'owner'), 'other-owner');
    fs.writeFileSync(path.join(slot, 'worktree'), `/worktree-${i}`);
    fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  }
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\n' +
      'if [ "$1" = display-message ]; then echo test-owner; exit 0; fi\n' +
      'if [ "$1" = has-session ]; then exit 0; fi\n' +
      'exit 1\n'
  );
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  for (const command of ['tmux', 'sleep']) fs.chmodSync(path.join(bin, command), 0o755);
  try {
    const child = spawnSync(path.join(repoRoot, '.kilo_workflow/.e2e-slot-state.sh'), ['acquire'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMUX_PANE: '%1',
      },
      timeout: 5000,
    });
    const waitIndex = child.stderr.indexOf('waiting for an E2E slot; holders:');
    const retryIndex = child.stderr.indexOf('retrying in');
    assert.ok(waitIndex >= 0, child.stderr);
    assert.ok(retryIndex < 0 || waitIndex < retryIndex, `wait not before retry: ${child.stderr}`);
    assert.match(child.stderr, /slot-1 other-owner \[\/worktree-1\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E start-resource iOS prebuilds, builds, and emits one compact claim JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-ios-start-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const commandLog = path.join(root, 'commands.log');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'test-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), root);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nif [ "$1" = display-message ]; then echo test-owner; exit 0; fi\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  makePnpmStub(bin, commandLog);
  makeNpxStub(bin, commandLog);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.kilo_workflow'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'apps/mobile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/.e2e-slot-state.sh'),
    path.join(wt, '.kilo_workflow/.e2e-slot-state.sh')
  );
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/e2e-start-resource.sh'),
    path.join(wt, '.kilo_workflow/e2e-start-resource.sh')
  );
  fs.chmodSync(path.join(wt, '.kilo_workflow/.e2e-slot-state.sh'), 0o755);
  fs.chmodSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(wt, '.gitignore'),
    '.env.local\napps/mobile/ios\napps/mobile/android\n'
  );
  execFileSync('git', ['-C', wt, 'add', '.']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'base']);
  try {
    const held = spawnSync(path.join(wt, '.kilo_workflow/.e2e-slot-state.sh'), ['_held'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMUX_PANE: '%1',
      },
    });
    assert.equal(
      held.status,
      0,
      `held failed: ${held.stderr} slot=${slot} owner=${fs.readFileSync(path.join(slot, 'owner'), 'utf8')}`
    );
    const result = spawnSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), ['ios'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
        TMUX_PANE: '%1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `expected single stdout line, got: ${result.stdout}`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.device.id, 'UDID-123');
    assert.doesNotMatch(result.stdout, /\n.*build/);
    assert.match(fs.readFileSync(commandLog, 'utf8'), /expo prebuild --platform ios/);
    assert.match(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:ios build UDID-123/);
    // Second invocation reuses the existing prebuild, so npx is not invoked again.
    fs.writeFileSync(commandLog, '');
    const reuse = spawnSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), ['ios'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
        TMUX_PANE: '%1',
      },
    });
    assert.equal(reuse.status, 0, reuse.stderr);
    assert.doesNotMatch(fs.readFileSync(commandLog, 'utf8'), /expo prebuild/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E start-resource android starts, claims, builds, and emits one compact record JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-android-start-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const commandLog = path.join(root, 'commands.log');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'test-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), root);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nif [ "$1" = display-message ]; then echo test-owner; exit 0; fi\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  makePnpmStub(bin, commandLog);
  makeNpxStub(bin, commandLog);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.kilo_workflow'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'apps/mobile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/.e2e-slot-state.sh'),
    path.join(wt, '.kilo_workflow/.e2e-slot-state.sh')
  );
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/e2e-start-resource.sh'),
    path.join(wt, '.kilo_workflow/e2e-start-resource.sh')
  );
  fs.chmodSync(path.join(wt, '.kilo_workflow/.e2e-slot-state.sh'), 0o755);
  fs.chmodSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(wt, '.gitignore'),
    '.env.local\napps/mobile/ios\napps/mobile/android\n'
  );
  execFileSync('git', ['-C', wt, 'add', '.']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'base']);
  try {
    const result = spawnSync(
      path.join(wt, '.kilo_workflow/e2e-start-resource.sh'),
      ['android', 'Pixel_8'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: path.join(root, 'tmp'),
          TMUX_PANE: '%1',
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `expected single stdout line, got: ${result.stdout}`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.serial, 'emulator-5554');
    assert.match(fs.readFileSync(commandLog, 'utf8'), /expo prebuild --platform android/);
    assert.match(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:android emulator-start/);
    assert.match(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:android claim emulator-5554/);
    assert.match(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:android build emulator-5554/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E start-resource android reuse skips emulator-start but still claims and builds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-android-reuse-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const commandLog = path.join(root, 'commands.log');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'test-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), root);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nif [ "$1" = display-message ]; then echo test-owner; exit 0; fi\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  makePnpmStub(bin, commandLog);
  makeNpxStub(bin, commandLog);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.kilo_workflow'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'apps/mobile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/.e2e-slot-state.sh'),
    path.join(wt, '.kilo_workflow/.e2e-slot-state.sh')
  );
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/e2e-start-resource.sh'),
    path.join(wt, '.kilo_workflow/e2e-start-resource.sh')
  );
  fs.chmodSync(path.join(wt, '.kilo_workflow/.e2e-slot-state.sh'), 0o755);
  fs.chmodSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(wt, '.gitignore'),
    '.env.local\napps/mobile/ios\napps/mobile/android\n'
  );
  execFileSync('git', ['-C', wt, 'add', '.']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'base']);
  const recordDir = path.join(root, 'tmp', 'kilo-mobile-android-emulators');
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(
    path.join(recordDir, `${path.basename(wt)}.json`),
    JSON.stringify(
      { serial: 'emulator-5554', pid: 123, log: '/tmp/log', worktreeRoot: wt },
      null,
      2
    )
  );
  try {
    const result = spawnSync(
      path.join(wt, '.kilo_workflow/e2e-start-resource.sh'),
      ['android', 'Pixel_8'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: path.join(root, 'tmp'),
          TMUX_PANE: '%1',
          BOOT_COMPLETED: '1',
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.serial, 'emulator-5554');
    assert.doesNotMatch(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:android emulator-start/);
    assert.match(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:android claim emulator-5554/);
    assert.match(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:android build emulator-5554/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E start-resource rejects a prebuild that creates tracked changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-prebuild-dirty-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const commandLog = path.join(root, 'commands.log');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'test-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), root);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nif [ "$1" = display-message ]; then echo test-owner; exit 0; fi\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  makePnpmStub(bin, commandLog);
  makeNpxStub(bin, commandLog);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.kilo_workflow'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'apps/mobile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/.e2e-slot-state.sh'),
    path.join(wt, '.kilo_workflow/.e2e-slot-state.sh')
  );
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/e2e-start-resource.sh'),
    path.join(wt, '.kilo_workflow/e2e-start-resource.sh')
  );
  fs.chmodSync(path.join(wt, '.kilo_workflow/.e2e-slot-state.sh'), 0o755);
  fs.chmodSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'Test']);
  // apps/mobile/ios is NOT ignored, so creating it counts as a tracked change.
  fs.writeFileSync(path.join(wt, '.gitignore'), '.env.local\napps/mobile/android\n');
  execFileSync('git', ['-C', wt, 'add', '.']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'base']);
  try {
    const result = spawnSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), ['ios'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
        TMUX_PANE: '%1',
        DIRTY_PREBUILD: '1',
      },
    });
    assert.notEqual(result.status, 0, `expected failure, got: ${result.stderr}`);
    assert.match(result.stderr, /prebuild for ios produced new tracked changes/);
    assert.equal(result.stdout.trim(), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E start-resource bundle --ios-only emits only ios summary lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-bundle-ios-only-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const commandLog = path.join(root, 'commands.log');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'test-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), root);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nif [ "$1" = display-message ]; then echo test-owner; exit 0; fi\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  makePnpmStub(bin, commandLog);
  makeNpxStub(bin, commandLog);
  fs.writeFileSync(
    path.join(bin, 'curl'),
    '#!/bin/sh\n' +
      'if [ "$1" = "-sf" ] && [ "$4" = "http://127.0.0.1:23750/v1.44/_ping" ]; then exit 0; fi\n' +
      'exit 1\n'
  );
  fs.chmodSync(path.join(bin, 'curl'), 0o755);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.kilo_workflow'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'apps/mobile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/.e2e-slot-state.sh'),
    path.join(wt, '.kilo_workflow/.e2e-slot-state.sh')
  );
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/e2e-start-resource.sh'),
    path.join(wt, '.kilo_workflow/e2e-start-resource.sh')
  );
  fs.chmodSync(path.join(wt, '.kilo_workflow/.e2e-slot-state.sh'), 0o755);
  fs.chmodSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(wt, '.gitignore'),
    '.env.local\napps/mobile/ios\napps/mobile/android\n'
  );
  execFileSync('git', ['-C', wt, 'add', '.']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'base']);
  try {
    const result = spawnSync(
      path.join(wt, '.kilo_workflow/e2e-start-resource.sh'),
      ['bundle', '--ios-only'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: path.join(root, 'tmp'),
          TMUX_PANE: '%1',
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const stdoutLines = result.stdout.split('\n').filter(Boolean);
    assert.equal(stdoutLines.length, 1);
    assert.match(stdoutLines[0], /^ios claim: /);
    const json = stdoutLines[0].replace(/^ios claim: /, '');
    assert.equal(JSON.parse(json).device.id, 'UDID-123');
    assert.doesNotMatch(result.stdout, /android record:/);
    assert.doesNotMatch(fs.readFileSync(commandLog, 'utf8'), /dev:mobile:android emulator-start/);
    assert.match(result.stderr, /bundle ready/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E2E start-resource build failure exits non-zero with no stdout JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-e2e-build-fail-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const commandLog = path.join(root, 'commands.log');
  const slot = path.join(home, '.cache/kilo-e2e-slots/slot-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner'), 'test-owner');
  fs.writeFileSync(path.join(slot, 'worktree'), root);
  fs.writeFileSync(path.join(slot, 'since'), '2026-01-01T00:00:00Z\n');
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nif [ "$1" = display-message ]; then echo test-owner; exit 0; fi\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  makePnpmStub(bin, commandLog);
  makeNpxStub(bin, commandLog);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.kilo_workflow'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'apps/mobile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/.e2e-slot-state.sh'),
    path.join(wt, '.kilo_workflow/.e2e-slot-state.sh')
  );
  fs.copyFileSync(
    path.join(repoRoot, '.kilo_workflow/e2e-start-resource.sh'),
    path.join(wt, '.kilo_workflow/e2e-start-resource.sh')
  );
  fs.chmodSync(path.join(wt, '.kilo_workflow/.e2e-slot-state.sh'), 0o755);
  fs.chmodSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'Test']);
  fs.writeFileSync(
    path.join(wt, '.gitignore'),
    '.env.local\napps/mobile/ios\napps/mobile/android\n'
  );
  execFileSync('git', ['-C', wt, 'add', '.']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'base']);
  try {
    const result = spawnSync(path.join(wt, '.kilo_workflow/e2e-start-resource.sh'), ['ios'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
        TMUX_PANE: '%1',
        IOS_BUILD_FAIL: '1',
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
