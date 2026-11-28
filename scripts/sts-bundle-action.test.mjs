// Runs .github/actions/sts-bundle/sts-bundle.sh with stand-in `curl` and `sleep` commands. The
// stand-in curl answers the GitHub OIDC request and the STS bundle request from files, records
// its argv and its config input, and the stand-in sleep records each wait.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const actionPath = new URL('../.github/actions/sts-bundle/', import.meta.url).pathname;
// A JWT-shaped stand-in: three base64url segments.
const OIDC_TOKEN = ['stand-in-header', 'stand-in-payload', 'stand-in-signature'].join('.');
const CLIENT_ID = 'client-id-value.access';
const CLIENT_SECRET = 'client-secret-value-0123456789';

const STUB_CURL = `#!/usr/bin/env bash
dir="$STUB_DIR"
output="" headers=""
printf '%s\\n' "$*" >>"$dir/argv.log"
while (($#)); do
  case $1 in
    --output) output=$2; shift ;;
    --dump-header) headers=$2; shift ;;
  esac
  shift
done
config=$(cat)
printf '%s\\n' "$config" >>"$dir/configs.log"
if [[ $config == *'/v1/bundle"'* ]]; then
  n=$(($(cat "$dir/sts.count" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$dir/sts.count"
  prefix="$dir/sts.$n"
  [[ -f $prefix.status ]] || prefix="$dir/sts"
else
  prefix="$dir/oidc"
fi
if [[ -f $prefix.exit ]]; then exit "$(cat "$prefix.exit")"; fi
[[ -z $output ]] || cp "$prefix.body" "$output"
if [[ -n $headers ]]; then cp "$prefix.headers" "$headers" 2>/dev/null || : >"$headers"; fi
printf '%s' "$(cat "$prefix.status")"
`;
const STUB_SLEEP = `#!/usr/bin/env bash
printf '%s\\n' "$1" >>"$STUB_DIR/sleeps.log"
`;

function bundle(overrides = {}) {
  return {
    environment: 'production',
    etag: '"etag-value-0123456789"',
    fetchedAt: '2026-01-01T00:00:00Z',
    missing: [],
    secrets: {
      E2E_ACCESS_CLIENT_ID: { value: CLIENT_ID, version: 1 },
      E2E_ACCESS_CLIENT_SECRET: { value: CLIENT_SECRET, version: 1 },
    },
    stale: false,
    status: 'ok',
    workload: 'ci-cloud-agent-e2e',
    ...overrides,
  };
}

function run({ sts = [{ status: 200, body: bundle() }], inputs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sts-bundle-test-'));
  try {
    const stubs = join(dir, 'bin');
    spawnSync('mkdir', ['-p', stubs]);
    writeFileSync(join(stubs, 'curl'), STUB_CURL);
    writeFileSync(join(stubs, 'sleep'), STUB_SLEEP);
    chmodSync(join(stubs, 'curl'), 0o755);
    chmodSync(join(stubs, 'sleep'), 0o755);
    writeFileSync(join(dir, 'oidc.status'), '200');
    writeFileSync(join(dir, 'oidc.body'), JSON.stringify({ value: OIDC_TOKEN }));
    sts.forEach((answer, index) => {
      const prefix = join(dir, `sts.${index + 1}`);
      writeFileSync(`${prefix}.status`, String(answer.status ?? '000'));
      writeFileSync(`${prefix}.body`, JSON.stringify(answer.body ?? {}));
      if (answer.exit !== undefined) writeFileSync(`${prefix}.exit`, String(answer.exit));
    });
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync('bash', [join(actionPath, 'sts-bundle.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${stubs}:${process.env.PATH}`,
        STUB_DIR: dir,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_ACTION_PATH: actionPath,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example.test/token?api-version=2.0',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token-value',
        INPUT_WORKLOAD: 'ci-cloud-agent-e2e',
        INPUT_SECRETS: 'E2E_ACCESS_CLIENT_ID\nE2E_ACCESS_CLIENT_SECRET\n',
        INPUT_STS_URL: 'https://sts.kiloapps.io',
        ...inputs,
      },
    });
    const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
    return {
      status: result.status,
      stdout: result.stdout,
      output: read('github-output'),
      argv: read('argv.log'),
      configs: read('configs.log'),
      sleeps: read('sleeps.log').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sets the requested keys as outputs and masks the token and every value', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout);
  assert.match(
    result.output,
    new RegExp(`E2E_ACCESS_CLIENT_ID<<ghadelimiter_[0-9a-f]{32}\\n${CLIENT_ID}\\n`)
  );
  assert.match(
    result.output,
    new RegExp(`E2E_ACCESS_CLIENT_SECRET<<ghadelimiter_[0-9a-f]{32}\\n${CLIENT_SECRET}\\n`)
  );
  for (const value of [OIDC_TOKEN, CLIENT_ID, CLIENT_SECRET]) {
    assert.ok(result.stdout.includes(`::add-mask::${value}`), `masks ${value}`);
    assert.ok(!result.argv.includes(value), 'never in a command line');
  }
  assert.ok(result.configs.includes('url = "https://sts.kiloapps.io/v1/bundle"'));
  assert.ok(result.configs.includes('audience=https%3A%2F%2Fsts.kiloapps.io'));
});

test('refuses a bundle of another workload, a stale bundle and a missing key', () => {
  for (const [body, message] of [
    [bundle({ workload: 'ci-other' }), /bundle of workload ci-other, not ci-cloud-agent-e2e/],
    [bundle({ stale: true }), /stale copy/],
    [
      bundle({ secrets: { E2E_ACCESS_CLIENT_ID: { value: CLIENT_ID, version: 1 } } }),
      /lacks requested keys: E2E_ACCESS_CLIENT_SECRET/,
    ],
    [{ status: 'ok' }, /does not have the expected shape/],
  ]) {
    const result = run({ sts: [{ status: 200, body }] });
    assert.equal(result.status, 1);
    assert.match(result.stdout, message);
    assert.equal(result.output, '');
  }
});

test('shows only the status words of a refusal and does not retry it', () => {
  const result = run({
    sts: [
      {
        status: 403,
        body: { status: 'denied', reason: 'policy_not_found', detail: 'secret text' },
      },
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /HTTP 403 \(denied policy_not_found\)/);
  assert.ok(!result.stdout.includes('secret text'));
  assert.deepEqual(result.sleeps, []);
});

test('retries a 503 after its retryAfterSeconds and a transport error after 5 s', () => {
  const result = run({
    sts: [
      { status: 503, body: { status: 'unavailable', retryAfterSeconds: 7 } },
      { exit: 28 },
      { status: 200, body: bundle() },
    ],
  });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.sleeps, ['7', '5']);
});

test('refuses an undeclared key, another STS origin and a missing OIDC permission', () => {
  for (const [inputs, message] of [
    [{ INPUT_SECRETS: 'GITHUB_TOKEN' }, /not an output of action.yml/],
    [{ INPUT_STS_URL: 'https://sts.example.test' }, /input sts-url must be/],
    [{ ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, /id-token: write/],
  ]) {
    const result = run({ inputs });
    assert.equal(result.status, 1);
    assert.match(result.stdout, message);
  }
});
