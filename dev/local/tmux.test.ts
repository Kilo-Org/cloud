import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { buildInteractiveShellCommand } from './tmux';

test('buildInteractiveShellCommand wraps quoted startup commands in parseable shell syntax', () => {
  const startupCommand =
    "PATH='/tmp/with spaces:/bin' PNPM_HOME='/tmp/pnpm home' node '/tmp/runner with spaces.js' --flag";

  const wrapped = buildInteractiveShellCommand(startupCommand, '/bin/sh');

  assert.match(wrapped, /^'\/bin\/sh' -lc /);
  assert.match(wrapped, /exec/);
  assert.match(wrapped, /PATH/);
  execFileSync('/bin/sh', ['-n', '-c', wrapped]);
});
