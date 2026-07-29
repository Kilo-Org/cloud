import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('maestro wrapper fails a zero-exit test whose JUnit report failed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-maestro-wrapper-'));
  const fake = path.join(root, 'maestro');
  fs.writeFileSync(
    fake,
    `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  [ "$1" = "--output" ] && { output=$2; shift 2; continue; }
  shift
done
printf '<testsuite failures="1"><testcase><failure/></testcase></testsuite>\\n' > "$output"
`
  );
  fs.chmodSync(fake, 0o755);
  try {
    const result = spawnSync(
      path.join(process.cwd(), 'apps/mobile/e2e/maestro.sh'),
      ['test-device', 'test', 'flow.yaml'],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TMPDIR: root },
        encoding: 'utf8',
      }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /JUnit reports a failed assertion/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
