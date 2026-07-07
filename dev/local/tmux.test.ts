import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { breakPane, buildInteractiveShellCommand, listWindows } from './tmux';
import { buildStartCommand, restartServiceInTmux } from './runner';

test('buildInteractiveShellCommand wraps quoted startup commands in parseable shell syntax', () => {
  const startupCommand =
    "PATH='/tmp/with spaces:/bin' PNPM_HOME='/tmp/pnpm home' node '/tmp/runner with spaces.js' --flag";

  const wrapped = buildInteractiveShellCommand(startupCommand, '/bin/sh');

  assert.match(wrapped, /^'\/bin\/sh' -lc /);
  assert.match(wrapped, /exec/);
  assert.match(wrapped, /PATH/);
  execFileSync('/bin/sh', ['-n', '-c', wrapped]);
});

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test(
  'breakPane keeps the requested service window name after tmux automatic rename',
  { skip: !hasTmux },
  () => {
    const sessionName = `kilo-tmux-test-${process.pid}-${Date.now()}`;
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
