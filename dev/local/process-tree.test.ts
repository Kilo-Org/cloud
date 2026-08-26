import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasNonShellDescendant,
  isShellCommand,
  parseProcessTable,
  snapshotProcessTable,
} from './process-tree';

test('parseProcessTable reads pid/ppid/comm columns and skips noise', () => {
  const rows = parseProcessTable(
    ['  501     1 /bin/zsh', '42371 42000 -zsh', 'header junk', '', ' 44496 42371 node'].join('\n')
  );

  assert.deepEqual(rows, [
    { pid: 501, ppid: 1, command: '/bin/zsh' },
    { pid: 42371, ppid: 42000, command: '-zsh' },
    { pid: 44496, ppid: 42371, command: 'node' },
  ]);
});

test('isShellCommand ignores login dashes and absolute paths', () => {
  assert.ok(isShellCommand('-zsh'));
  assert.ok(isShellCommand('/bin/zsh'));
  assert.ok(isShellCommand(' sh '));
  assert.ok(!isShellCommand('node'));
  assert.ok(!isShellCommand('/opt/homebrew/bin/cloudflared'));
  assert.ok(!isShellCommand('shell-service')); // basename must match exactly
});

test('a pane whose only children are leftover shells counts as idle', () => {
  // The §1 repro: wrangler exited, ctrl-c left a second login shell under the
  // pane shell. Restart used to read this as "still shutting down" for 60s.
  const rows = parseProcessTable(['42371 42000 -zsh', '44496 42371 -zsh'].join('\n'));

  assert.equal(hasNonShellDescendant(rows, 42371), false);
});

test('a service under intermediate shell layers counts as running', () => {
  // pnpm runs package scripts through `sh -c`, so the live service is never a
  // depth-1 child: stopping at the first shell would call wrangler idle.
  const rows = parseProcessTable(
    ['42371 42000 -zsh', '44496 42371 sh', '44500 44496 node'].join('\n')
  );

  assert.equal(hasNonShellDescendant(rows, 42371), true);
});

test('reparented grandchildren of a dead supervisor do not count', () => {
  // cloudflared reparented to pid 1 is no longer under the pane — status must
  // not credit the pane for it.
  const rows = parseProcessTable(['42371 42000 -zsh', '9001 1 cloudflared'].join('\n'));

  assert.equal(hasNonShellDescendant(rows, 42371), false);
});

test('hasNonShellDescendant terminates on a self-parented row', () => {
  const rows = parseProcessTable(['42371 42371 -zsh', '44496 42371 -zsh'].join('\n'));

  assert.equal(hasNonShellDescendant(rows, 42371), false);
});

test('snapshotProcessTable sees this process under a real ps', () => {
  const rows = snapshotProcessTable();

  assert.ok(rows.length > 1);
  assert.ok(rows.some(row => row.pid === process.pid));
});

test('the current test process is a non-shell descendant of its own parent', () => {
  const rows = snapshotProcessTable();
  const self = rows.find(row => row.pid === process.pid);
  assert.ok(self);

  assert.equal(hasNonShellDescendant(rows, self.ppid), true);
});
