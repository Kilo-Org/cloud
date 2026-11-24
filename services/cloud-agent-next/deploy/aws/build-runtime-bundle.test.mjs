import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildAwsRuntimeBundle } from './build-runtime-bundle.mjs';

const baseImage = `123456789012.dkr.ecr.us-east-1.amazonaws.com/runtime@sha256:${'a'.repeat(64)}`;
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'aws-runtime-bundle-test-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('creates deterministic ZIP bytes with only the approved source files and AWS Python installation', () =>
  fixture(root => {
    writeFileSync(join(root, '.env.local'), 'SECRET=must-not-enter-the-artifact');
    const first = join(root, 'first.zip');
    const second = join(root, 'second.zip');
    const result = buildAwsRuntimeBundle({ baseImage, output: first });
    const previousUmask = process.umask(0o077);
    try {
      assert.deepEqual(buildAwsRuntimeBundle({ baseImage, output: second }), result);
    } finally {
      process.umask(previousUmask);
    }
    assert.deepEqual(readFileSync(first), readFileSync(second));
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.deepEqual(
      execFileSync('unzip', ['-Z1', first], { encoding: 'utf8' }).trim().split('\n'),
      ['Dockerfile', 'launch-document.mjs']
    );
    const dockerfile = execFileSync('unzip', ['-p', first, 'Dockerfile'], { encoding: 'utf8' });
    assert.ok(dockerfile.startsWith(`FROM --platform=linux/amd64 ${baseImage}\n`));
    assert.match(dockerfile, /apt-get install -y --no-install-recommends python3/);
    assert.match(dockerfile, /\nCOPY launch-document\.mjs \/opt\/kilo\/aws\/\n/);
    // The ECS task definition owns the entrypoint.
    assert.doesNotMatch(dockerfile, /(?:^|\n)(?:ENTRYPOINT|CMD) /);
    assert.doesNotMatch(dockerfile, /(?:^|\n)(?:ENV|ARG) /);
    for (const loader of ['launch-document.mjs']) {
      assert.deepEqual(
        execFileSync('unzip', ['-p', first, loader]),
        readFileSync(new URL(`./runtime/${loader}`, import.meta.url))
      );
    }
  }));

test('refuses mutable, public, foreign-region or malformed base references', () =>
  fixture(root => {
    for (const invalid of [
      baseImage.replace(/@sha256:.+$/, ':latest'),
      'node:24',
      baseImage.replace('us-east-1', 'eu-west-1'),
      baseImage.replace('/runtime@', '/runtime/../other@'),
      baseImage + '\nRUN false',
      'https://user:password@example.com/image',
    ]) {
      assert.throws(
        () => buildAwsRuntimeBundle({ baseImage: invalid, output: join(root, 'rejected.zip') }),
        /private us-east-1 ECR image pinned/
      );
    }
  }));

test('preserves an existing destination and never appends to an old artifact', () =>
  fixture(root => {
    const output = join(root, 'existing.zip');
    writeFileSync(output, 'preserve-existing-output');
    assert.throws(() => buildAwsRuntimeBundle({ baseImage, output }), { code: 'EEXIST' });
    assert.equal(readFileSync(output, 'utf8'), 'preserve-existing-output');
  }));
