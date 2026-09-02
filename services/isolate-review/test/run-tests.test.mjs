import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const runner = resolve(import.meta.dirname, 'run-tests.mjs');
const fixture = 'test/integration/harness.test.ts';

async function run(args = ['--maxWorkers=1'], cancelAfterStart = false) {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT'].flatMap(name => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
  Object.assign(env, {
    KILOCODE_BACKEND_BASE_URL: 'https://developer.invalid',
    KILO_GATEWAY_URL: 'https://developer.invalid/gateway',
    NEXTAUTH_SECRET: 'must-not-be-inherited',
    INTERNAL_API_SECRET: 'must-not-be-inherited',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
      'postgresql://fixture:fixture@localhost:8232/review_e2e_isolate_absent_20260902',
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
      'postgresql://fixture:fixture@localhost:8232/review_e2e_isolate_absent_20260902',
  });
  const child = spawn(process.execPath, [runner, fixture, '--reporter=verbose', ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  assert.ok(pid);
  let output = '';
  let timedOut = false;
  let interrupted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, 30_000);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      output += chunk.toString();
      if (cancelAfterStart && !interrupted && output.includes(' RUN ')) {
        interrupted = true;
        child.kill('SIGTERM');
      }
    });
  }
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(timedOut, false, 'The test runner did not close within its test deadline');
    assert.equal(signal, null, 'The test runner must exit normally, not from a signal');
    assert.doesNotMatch(output, /Using secrets defined|close timed out|Timeout terminating/);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    return { code, output: stripVTControlCharacters(output), pid, interrupted };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

test('the declared runner closes its Worker pool and exits without inherited developer inputs', async t => {
  const result = await run();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /3 passed \(3\)/);
  t.diagnostic(`runner pid=${result.pid}, exit=0, signal=null, process absent`);
});

test('the runner preserves configuration failure instead of reporting success after close', async t => {
  const result = await run(['--maxWorkers=1', '--environment=unsupported-worker-environment']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Unexpected custom `environment`/);
  t.diagnostic(`runner pid=${result.pid}, exit=1, signal=null, process absent`);
});

test('the runner awaits pool cleanup on cancellation and keeps a nonzero exit status', async t => {
  const result = await run(['--maxWorkers=1'], true);
  assert.equal(result.interrupted, true);
  assert.equal(result.code, 143, result.output);
  t.diagnostic(`runner pid=${result.pid}, exit=143, signal=null, process absent`);
});
