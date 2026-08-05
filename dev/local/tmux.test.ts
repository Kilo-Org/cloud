import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  breakPane,
  buildInteractiveShellCommand,
  captureServicePane,
  listWindows,
  createSession,
  createWindow,
  killSession,
  pipeServicePane,
  setPaneServiceIdentity,
} from './tmux';
import {
  buildFollowLogPipeCommand,
  buildLogPipeCommand,
  buildStartCommand,
  restartServiceInTmux,
} from './runner';

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('buildInteractiveShellCommand wraps quoted startup commands in parseable shell syntax', () => {
  const startupCommand =
    "PATH='/tmp/with spaces:/bin' PNPM_HOME='/tmp/pnpm home' node '/tmp/runner with spaces.js' --flag";

  const wrapped = buildInteractiveShellCommand(startupCommand, '/bin/sh');

  assert.match(wrapped, /^'\/bin\/sh' -lc /);
  assert.match(wrapped, /exec/);
  assert.match(wrapped, /PATH/);
  execFileSync('/bin/sh', ['-n', '-c', wrapped]);

  const rooted = buildInteractiveShellCommand(startupCommand, '/bin/sh', '/tmp/worktree root');
  assert.match(rooted, /^'\/bin\/sh' -c /);
  assert.match(rooted, /cd .*tmp\/worktree root/);
  execFileSync('/bin/sh', ['-n', '-c', rooted]);
});

test(
  'new tmux sessions and service windows ignore stale global worktree environment',
  { skip: !hasTmux },
  async () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const marker = path.join(os.tmpdir(), `${sessionName}-pwd`);
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });
    const tmuxOutput = (...args: string[]) =>
      execFileSync('tmux', args, { encoding: 'utf8' }).trim();
    const savedGlobalEnvironment = new Map<string, string | undefined>();
    for (const key of ['PWD', 'OLDPWD']) {
      try {
        savedGlobalEnvironment.set(
          key,
          tmuxOutput('show-environment', '-g', key).slice(key.length + 1)
        );
      } catch {
        savedGlobalEnvironment.set(key, undefined);
      }
    }

    try {
      const staleWorktree = path.join(os.tmpdir(), 'deleted-sibling-worktree');
      tmux('set-environment', '-g', 'PWD', staleWorktree);
      tmux('set-environment', '-g', 'OLDPWD', staleWorktree);
      createSession(sessionName);

      assert.equal(
        tmuxOutput('display-message', '-p', '-t', `${sessionName}:0.0`, '#{pane_current_path}'),
        repoRoot
      );
      const windowIndex = createWindow(
        sessionName,
        'service',
        undefined,
        `pwd > ${JSON.stringify(marker)}`
      );
      for (let i = 0; i < 20 && !fs.existsSync(marker); i++) await sleep(50);
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), repoRoot);
      assert.doesNotMatch(
        tmuxOutput('capture-pane', '-p', '-J', '-t', `${sessionName}:${windowIndex}.0`),
        /shell-init: error retrieving current directory/
      );
      assert.equal(
        tmuxOutput(
          'display-message',
          '-p',
          '-t',
          `${sessionName}:${windowIndex}.0`,
          '#{pane_current_path}'
        ),
        repoRoot
      );
    } finally {
      fs.rmSync(marker, { force: true });
      try {
        killSession(sessionName);
      } catch {
        // Session may already be gone if setup fails.
      }
      for (const [key, value] of savedGlobalEnvironment) {
        try {
          if (value === undefined) tmux('set-environment', '-gu', key);
          else tmux('set-environment', '-g', key, value);
        } catch {
          // The variable may not exist in this tmux version's environment.
        }
      }
    }
  }
);

const hasScript = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test(
  'captureServicePane follows a service after the dashboard moves its pane',
  { skip: !hasTmux },
  () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const serviceName = 'mobile';
    const output = path.join(os.tmpdir(), `${sessionName}.log`);
    const followOutput = path.join(os.tmpdir(), `${sessionName}-follow.log`);
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });

    try {
      tmux('new-session', '-d', '-s', sessionName, '-n', 'dashboard', 'sleep 120');
      tmux('new-window', '-d', '-t', sessionName, '-n', serviceName, '/bin/sh');
      const serviceWindow = listWindows(sessionName).find(window => window.name === serviceName);
      assert.ok(serviceWindow);
      setPaneServiceIdentity(sessionName, serviceWindow.index, 0, serviceName);
      tmux(
        'send-keys',
        '-t',
        `${sessionName}:${serviceWindow.index}.0`,
        'printf "worktree-mobile-pane\\n"',
        'Enter'
      );
      tmux(
        'join-pane',
        '-h',
        '-s',
        `${sessionName}:${serviceWindow.index}.0`,
        '-t',
        `${sessionName}:0.0`
      );
      assert.match(captureServicePane(sessionName, serviceName, 20), /worktree-mobile-pane/);
      pipeServicePane(sessionName, serviceName, buildFollowLogPipeCommand(output, followOutput));
      tmux('send-keys', '-t', `${sessionName}:0.1`, 'printf "followed-pane\\n"', 'Enter');
      for (
        let i = 0;
        i < 60 &&
        (!fs.existsSync(followOutput) ||
          !fs.readFileSync(followOutput, 'utf8').includes('followed-pane') ||
          !fs.existsSync(output) ||
          !fs.readFileSync(output, 'utf8').includes('followed-pane'));
        i++
      ) {
        execFileSync('sleep', ['0.05']);
      }
      assert.match(fs.readFileSync(output, 'utf8'), /followed-pane/);
      assert.match(fs.readFileSync(followOutput, 'utf8'), /followed-pane/);
      pipeServicePane(sessionName, serviceName, buildLogPipeCommand(output));
      tmux('send-keys', '-t', `${sessionName}:0.1`, 'printf "replacement-pane\\n"', 'Enter');
      for (
        let i = 0;
        i < 60 &&
        (!fs.existsSync(output) || !fs.readFileSync(output, 'utf8').includes('replacement-pane'));
        i++
      ) {
        execFileSync('sleep', ['0.05']);
      }
      assert.match(fs.readFileSync(output, 'utf8'), /replacement-pane/);
      assert.doesNotMatch(fs.readFileSync(followOutput, 'utf8'), /replacement-pane/);
    } finally {
      fs.rmSync(output, { force: true });
      fs.rmSync(followOutput, { force: true });
      try {
        tmux('kill-session', '-t', sessionName);
      } catch {
        // Session may already be gone if tmux fails during setup.
      }
    }
  }
);

test(
  'breakPane keeps the requested service window name after tmux automatic rename',
  { skip: !hasTmux },
  () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const otherSessionName = `${sessionName}-other`;
    const serviceName = 'nextjs';
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });
    const tmuxOutput = (...args: string[]) =>
      execFileSync('tmux', args, { encoding: 'utf-8' }).trim();

    try {
      tmux('new-session', '-d', '-s', sessionName, '-n', 'dashboard', 'sleep 120');
      tmux(
        'new-window',
        '-d',
        '-t',
        sessionName,
        '-n',
        serviceName,
        'sh -lc "while true; do sleep 60; done"'
      );

      const serviceWindow = listWindows(sessionName).find(window => window.name === serviceName);
      assert.ok(serviceWindow);

      tmux(
        'join-pane',
        '-h',
        '-s',
        `${sessionName}:${serviceWindow.index}.0`,
        '-t',
        `${sessionName}:0.0`
      );

      // A second active session makes the tmux current session ambiguous. The
      // old unqualified break-pane created the new window in the current
      // session, which could be the other session; the session-qualified
      // production fix always targets the requested source session.
      tmux('new-session', '-d', '-s', otherSessionName, '-n', 'other', 'sleep 120');

      const newWindowIndex = breakPane(sessionName, 0, 1, serviceName);
      const window = listWindows(sessionName).find(entry => entry.index === newWindowIndex);

      assert.deepEqual(window, { index: newWindowIndex, name: serviceName });
      assert.equal(
        tmuxOutput(
          'display-message',
          '-p',
          '-t',
          `${sessionName}:${newWindowIndex}`,
          '#{automatic-rename}'
        ),
        '0'
      );
      assert.ok(
        listWindows(otherSessionName).every(entry => entry.name !== serviceName),
        'broken-out window must not land in the other active session'
      );
    } finally {
      try {
        tmux('kill-session', '-t', sessionName);
      } catch {
        // Session may already be gone if tmux fails during setup.
      }
      try {
        tmux('kill-session', '-t', otherSessionName);
      } catch {
        // Session may already be gone if tmux fails during setup.
      }
    }
  }
);

test(
  'breakPane creates the window in the requested session when a real foreign client is attached',
  { skip: !hasTmux || !hasScript },
  () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const decoySession = `kilo-tmux-test-decoy-${process.pid}-${Date.now()}`;
    const serviceName = 'nextjs';
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });
    const tmuxOutput = (...args: string[]) =>
      execFileSync('tmux', args, { encoding: 'utf-8' }).trim();

    // Attach a real client to the decoy session through a pseudoterminal.
    // A forged TMUX env var alone does not steer break-pane — tmux requires
    // an actual attached client for the "current session" to differ from the
    // source pane's session.  script(1) provides the pty so tmux can attach.
    //
    // Strip TMUX and TMUX_PANE from the child environment.  When the test
    // itself runs inside tmux, the child script inherits those variables and
    // the nested tmux refuses to attach its decoy session.
    const {
      TMUX: _childTmux,
      TMUX_PANE: _childTmuxPane,
      ...childEnv
    } = process.env as Record<string, string | undefined>;
    childEnv.TERM = process.env.TERM ?? 'xterm-256color';

    const clientProc =
      process.platform === 'darwin'
        ? spawn(
            'script',
            ['-q', '/dev/null', 'tmux', 'new-session', '-s', decoySession, 'sleep', '999'],
            { stdio: 'ignore', env: childEnv }
          )
        : spawn(
            'script',
            ['-q', '-c', `tmux new-session -s ${decoySession} sleep 999`, '/dev/null'],
            { stdio: 'ignore', env: childEnv }
          );

    const savedTmux = process.env.TMUX;
    try {
      // Wait for the decoy client to attach (up to 2 s).
      let clientReady = false;
      for (let i = 0; i < 20 && !clientReady; i++) {
        try {
          const attached = tmuxOutput(
            'display-message',
            '-t',
            `=${decoySession}:0`,
            '-p',
            '#{session_attached}'
          );
          clientReady = parseInt(attached, 10) > 0;
        } catch {
          // Session not yet visible.
        }
        if (!clientReady) execFileSync('sleep', ['0.1']);
      }
      assert.ok(clientReady, 'decoy session must have an attached client');

      // Point child tmux commands at the decoy session.  The trailing colon
      // is required: display-message -t =<session> without it returns no ID.
      const socketPath = tmuxOutput('display-message', '-p', '#{socket_path}');
      const sessionId = tmuxOutput(
        'display-message',
        '-t',
        `=${decoySession}:`,
        '-p',
        '#{session_id}'
      );
      const sessionCreated = sessionId.replace(/^\$/, '');
      process.env.TMUX = `${socketPath},${sessionCreated},0`;

      // Set up the test session with a joined pane, then break it out.
      tmux('new-session', '-d', '-s', sessionName, '-n', 'dashboard', 'sleep', '120');
      tmux(
        'new-window',
        '-d',
        '-t',
        sessionName,
        '-n',
        serviceName,
        'sh -lc "while true; do sleep 60; done"'
      );

      const serviceWindow = listWindows(sessionName).find(window => window.name === serviceName);
      assert.ok(serviceWindow);

      tmux(
        'join-pane',
        '-h',
        '-s',
        `${sessionName}:${serviceWindow.index}.0`,
        '-t',
        `${sessionName}:0.0`
      );

      const newWindowIndex = breakPane(sessionName, 0, 1, serviceName);

      // The window must belong to the requested session, not the decoy.
      const windowSession = tmuxOutput(
        'display-message',
        '-t',
        `${sessionName}:${newWindowIndex}`,
        '-p',
        '#{session_name}'
      );
      assert.equal(windowSession, sessionName);

      // Verify window name and that automatic rename is disabled.
      const window = listWindows(sessionName).find(entry => entry.index === newWindowIndex);
      assert.deepEqual(window, { index: newWindowIndex, name: serviceName });
      assert.equal(
        tmuxOutput(
          'display-message',
          '-p',
          '-t',
          `${sessionName}:${newWindowIndex}`,
          '#{automatic-rename}'
        ),
        '0'
      );
    } finally {
      // Restore the inherited TMUX value.
      if (savedTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = savedTmux;
      }
      // Detach the script client, then tear down both sessions.
      clientProc.kill('SIGTERM');
      try {
        tmux('kill-session', '-t', `=${decoySession}`);
      } catch {
        // Session may already be gone.
      }
      try {
        tmux('kill-session', '-t', `=${sessionName}`);
      } catch {
        // Session may already be gone.
      }
    }
  }
);

test(
  'restartServiceInTmux re-resolves the service pane after dashboard pane moves',
  { skip: !hasTmux },
  async () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const serviceName = 'stripe';
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });

    try {
      tmux('new-session', '-d', '-s', sessionName, '-n', 'dashboard', 'sleep 120');
      tmux('new-window', '-d', '-t', sessionName, '-n', serviceName, '/bin/sh');

      const serviceWindow = listWindows(sessionName).find(window => window.name === serviceName);
      assert.ok(serviceWindow);

      tmux(
        'join-pane',
        '-h',
        '-s',
        `${sessionName}:${serviceWindow.index}.0`,
        '-t',
        `${sessionName}:0.0`
      );
      tmux('select-pane', '-t', `${sessionName}:0.1`, '-T', serviceName);

      void restartServiceInTmux(sessionName, serviceName);
      breakPane(sessionName, 0, 1, serviceName);

      await sleep(1200);
      assert.ok(listWindows(sessionName).some(window => window.name === serviceName));
    } finally {
      try {
        tmux('kill-session', '-t', sessionName);
      } catch {
        // Session may already be gone if tmux fails during setup.
      }
    }
  }
);

test(
  'restartServiceInTmux injects escaped env values into a non-POSIX shell',
  { skip: !hasTmux || !fs.existsSync('/bin/tcsh') },
  async () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const serviceName = 'stripe';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-tmux-test-env-'));
    const marker = path.join(tempDir, 'env-value');
    const envValue = "space ' quote $dollar; semicolon";
    const fakeTsx = path.join(tempDir, 'tsx');
    const foregroundProcess = path.join(tempDir, 'foreground-process');
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });

    fs.writeFileSync(fakeTsx, `#!/bin/sh\nprintf '%s' "$KILO_TEST_VALUE" > "$KILO_TEST_MARKER"\n`);
    fs.writeFileSync(
      foregroundProcess,
      "#!/bin/sh\ntrap 'exit 0' INT TERM\nwhile :; do sleep 1; done\n"
    );
    fs.chmodSync(fakeTsx, 0o755);
    fs.chmodSync(foregroundProcess, 0o755);

    try {
      tmux('new-session', '-d', '-s', sessionName, '-n', 'dashboard', 'sleep 120');
      tmux('new-window', '-d', '-t', sessionName, '-n', serviceName, '/bin/tcsh');

      const serviceWindow = listWindows(sessionName).find(window => window.name === serviceName);
      assert.ok(serviceWindow);

      tmux(
        'send-keys',
        '-t',
        `${sessionName}:${serviceWindow.index}.0`,
        foregroundProcess,
        'Enter'
      );
      let fixtureUp = false;
      for (let i = 0; i < 20 && !fixtureUp; i++) {
        const panePid = execFileSync(
          'tmux',
          ['display-message', '-p', '-t', `${sessionName}:${serviceWindow.index}.0`, '#{pane_pid}'],
          { encoding: 'utf-8' }
        ).trim();
        try {
          execFileSync('pgrep', ['-P', panePid], { stdio: 'ignore' });
          fixtureUp = true;
        } catch {
          await sleep(50);
        }
      }
      assert.ok(fixtureUp, 'foreground process should start under tcsh');

      const outcome = await restartServiceInTmux(sessionName, serviceName, {
        KILO_TEST_MARKER: marker,
        KILO_TEST_VALUE: envValue,
        PATH: `${tempDir}:${process.env.PATH ?? ''}`,
      });

      assert.equal(outcome, 'relaunched');
      for (let i = 0; i < 20 && !fs.existsSync(marker); i++) await sleep(50);
      assert.equal(fs.readFileSync(marker, 'utf-8'), envValue);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
      try {
        tmux('kill-session', '-t', sessionName);
      } catch {
        // Session may already be gone if tmux fails during setup.
      }
    }
  }
);

test(
  'restartServiceInTmux waits for a slow shutdown before sending the relaunch command',
  { skip: !hasTmux },
  async () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const serviceName = 'stripe';
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });
    // Emulate wrangler-style shutdown: the process holds the tty in raw mode
    // (interactive hotkeys), so ctrl-c never becomes SIGINT — it arrives as
    // byte 0x03 and triggers a shutdown that takes seconds. Keystrokes sent
    // while it is still alive are swallowed by its raw stdin and never reach
    // the shell — the marker file records any such swallowed input.
    const script = path.join(os.tmpdir(), `kilo-tmux-test-slow-${process.pid}.js`);
    const swallowedMarker = path.join(os.tmpdir(), `kilo-tmux-test-swallowed-${process.pid}`);
    fs.writeFileSync(
      script,
      `const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdin.on('data', d => {
  if (d.includes(3)) { setTimeout(() => process.exit(0), 3000); return; }
  fs.appendFileSync(${JSON.stringify(swallowedMarker)}, d);
});`
    );

    try {
      tmux('new-session', '-d', '-s', sessionName, '-n', 'dashboard', 'sleep 120');
      tmux(
        'new-window',
        '-d',
        '-t',
        sessionName,
        '-n',
        serviceName,
        buildInteractiveShellCommand(`'${process.execPath}' '${script}'`)
      );

      const serviceWindow = listWindows(sessionName).find(window => window.name === serviceName);
      assert.ok(serviceWindow);

      tmux(
        'join-pane',
        '-h',
        '-s',
        `${sessionName}:${serviceWindow.index}.0`,
        '-t',
        `${sessionName}:0.0`
      );
      tmux('select-pane', '-t', `${sessionName}:0.1`, '-T', serviceName);

      // The wrapper is a login shell whose startup (version managers etc.)
      // can take seconds; the interrupt must land while the service process
      // is alive, otherwise this degenerates into the pane-death scenario.
      // Anchor the pattern to the node binary — the wrapper shell's own
      // cmdline also contains the script path and must not match.
      let fixtureUp = false;
      for (let i = 0; i < 40 && !fixtureUp; i++) {
        try {
          execFileSync('pgrep', ['-f', `^${process.execPath} .*${script}`], { stdio: 'ignore' });
          fixtureUp = true;
        } catch {
          await sleep(250);
        }
      }
      assert.ok(fixtureUp, 'slow-shutdown fixture process should start');

      // A second restart before the first settles must take over the poll —
      // otherwise both would relaunch, and the slower one would interrupt
      // the freshly started service partway through its own poll.
      const supersededRestart = restartServiceInTmux(sessionName, serviceName);
      const outcome = await restartServiceInTmux(sessionName, serviceName);
      assert.equal(await supersededRestart, 'superseded');
      assert.ok(
        outcome === 'relaunched' || outcome === 'recreated',
        `restart should settle with a relaunch, got '${outcome}'`
      );

      await sleep(500); // let the relaunch keystrokes echo before capturing
      // Depending on the wrapper shell's SIGINT semantics the pane either
      // survives (relaunch typed into its shell) or closes with the process
      // (service window recreated). Both count as a restart; the old fixed
      // 1s delay produced neither — the keystrokes vanished into the dying
      // process and the service stayed stopped.
      const windowRecreated = listWindows(sessionName).some(window => window.name === serviceName);
      let paneEchoedCommand = false;
      try {
        const paneContent = execFileSync(
          'tmux',
          ['capture-pane', '-p', '-J', '-t', `${sessionName}:0.1`],
          { encoding: 'utf-8' }
        );
        paneEchoedCommand = paneContent.includes(buildStartCommand(serviceName));
      } catch {
        // Pane closed with the process — the recreate branch applies.
      }
      assert.ok(
        !fs.existsSync(swallowedMarker),
        'relaunch keystrokes must not be fed to the still-running process'
      );
      assert.ok(
        windowRecreated || paneEchoedCommand,
        'service should be relaunched after the slow shutdown completes'
      );
    } finally {
      fs.rmSync(script, { force: true });
      fs.rmSync(swallowedMarker, { force: true });
      try {
        tmux('kill-session', '-t', sessionName);
      } catch {
        // Session may already be gone if tmux fails during setup.
      }
    }
  }
);

test(
  'restartServiceInTmux recreates the service window when the pane dies with the process',
  { skip: !hasTmux },
  async () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
    const serviceName = 'stripe';
    const tmux = (...args: string[]) => execFileSync('tmux', args, { stdio: 'ignore' });

    try {
      tmux('new-session', '-d', '-s', sessionName, '-n', 'dashboard', 'sleep 120');
      // Run the process directly (no wrapper shell) so the pane closes as
      // soon as SIGINT kills it — the state restart used to silently bail
      // on after reporting success.
      tmux('new-window', '-d', '-t', sessionName, '-n', serviceName, 'sleep 120');

      const serviceWindow = listWindows(sessionName).find(window => window.name === serviceName);
      assert.ok(serviceWindow);

      tmux(
        'join-pane',
        '-h',
        '-s',
        `${sessionName}:${serviceWindow.index}.0`,
        '-t',
        `${sessionName}:0.0`
      );
      tmux('select-pane', '-t', `${sessionName}:0.1`, '-T', serviceName);

      const outcome = await restartServiceInTmux(sessionName, serviceName);

      assert.equal(outcome, 'recreated');
      assert.ok(
        listWindows(sessionName).some(window => window.name === serviceName),
        'service window should be recreated after its pane closed on interrupt'
      );
    } finally {
      try {
        tmux('kill-session', '-t', sessionName);
      } catch {
        // Session may already be gone if tmux fails during setup.
      }
    }
  }
);
