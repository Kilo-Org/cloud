import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { breakPane, buildInteractiveShellCommand, listWindows } from './tmux';
import { restartServiceInTmux } from './runner';

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

      restartServiceInTmux(sessionName, serviceName);
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
