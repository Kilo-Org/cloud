import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Ported from Kilo-Org/bouncer scripts/sts-deploy-token.test.mjs; the cloud script also takes
// STS_ENVIRONMENT, which picks the STS (audience and host).
const SCRIPT = path.join(import.meta.dirname, 'ci', 'sts-deploy-token.sh');
const AUDIENCE = 'https://sts.kiloapps.io';
const STAGING_AUDIENCE = 'https://sts-staging.kiloapps.io';
const MINT_PATH = '/v1/ci/cloudflare-deploy-token';
const REVOKE_PATH = '/v1/ci/cloudflare-deploy-token/revoke';
const REQUEST_TOKEN = 'request-bearer-7f3a';
const OIDC_TOKEN = 'oidc.jwt-91c2';
const TOKEN = 'cfat_SECRETdeploy0123';
const TOKEN_ID = '0123456789abcdef0123456789abcdef';
const ISSUED = {
  expiresAt: '2026-11-27T12:00:00.000Z',
  permissionSet: 'cloud-workers-deploy',
  status: 'ok',
  token: TOKEN,
  tokenId: TOKEN_ID,
  ttlSeconds: 3600,
};
const REAL_CURL = execFileSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim();
// Logs each argument on its own line, then runs the real curl, or with CURL_SHIM_FAKE=1 answers
// the OIDC request itself and fails every other call as unreachable (exit 7) without sending it.
const CURL_SHIM = `#!/bin/sh
printf '%s\\n' "$@" '@@end@@' >>"$CURL_SHIM_LOG"
if [ "$CURL_SHIM_FAKE" != 1 ]; then exec "$CURL_SHIM_REAL" "$@"; fi
cat >/dev/null
case "$*" in *audience=*) printf '{"value":"%s"}' "$CURL_SHIM_OIDC"; exit 0 ;; esac
exit 7
`;

/**
 * A stand-in for GitHub's OIDC endpoint and STS. Each answer is `{ status, body }`; a string body is
 * sent as is. It records every request.
 */
async function stub(answers) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      const url = new URL(request.url, 'http://stub');
      requests.push({
        authorization: request.headers.authorization,
        body,
        contentType: request.headers['content-type'],
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      });
      const answer = answers[url.pathname] ?? { body: '', status: 404 };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, server, url: `http://127.0.0.1:${server.address().port}` };
}

function stsAnswers(route, status, body) {
  return { '/oidc': { body: { value: OIDC_TOKEN }, status: 200 }, [route]: { body, status } };
}

/**
 * Runs the script with only PATH and `env`, leaving out undefined values; a non-zero exit is
 * returned, not thrown.
 */
async function run(args, env) {
  const defined = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined)
  );
  try {
    const { stderr, stdout } = await execFileAsync('bash', [SCRIPT, ...args], { env: defined });
    return { code: 0, stderr, stdout };
  } catch (error) {
    return { code: error.code, stderr: error.stderr, stdout: error.stdout };
  }
}

/**
 * Runs the script against a stub in test mode (STS_DEPLOY_TOKEN_TEST=1, STS_URL at the stub).
 * `output: "file"` gives it a fresh GITHUB_OUTPUT file; any other value points GITHUB_OUTPUT at a
 * directory, so every write to it fails. `shim` puts the logging curl first on PATH: "real" runs
 * the real curl, "fake" sends nothing. `curlArgs` lists each curl call's arguments.
 */
async function runAgainst(answers, args, { env = {}, output = 'file', shim } = {}) {
  const { requests, server, url } = await stub(answers);
  const dir = mkdtempSync(path.join(tmpdir(), 'sts-deploy-token-'));
  const outputPath = path.join(dir, 'output');
  const curlLog = path.join(dir, 'curl.log');
  if (output === 'file') {
    writeFileSync(outputPath, '');
  }
  if (shim) {
    writeFileSync(path.join(dir, 'curl'), CURL_SHIM);
    chmodSync(path.join(dir, 'curl'), 0o755);
    writeFileSync(curlLog, '');
  }
  try {
    const result = await run(args, {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/oidc?api-version=2.0`,
      CURL_SHIM_FAKE: shim === 'fake' ? '1' : undefined,
      CURL_SHIM_LOG: curlLog,
      CURL_SHIM_OIDC: OIDC_TOKEN,
      CURL_SHIM_REAL: REAL_CURL,
      GITHUB_OUTPUT: output === 'file' ? outputPath : dir,
      PATH: shim ? `${dir}:${process.env.PATH}` : process.env.PATH,
      STS_DEPLOY_TOKEN_TEST: '1',
      STS_ENVIRONMENT: 'production',
      STS_URL: url,
      ...env,
    });
    const written = output === 'file' ? readFileSync(outputPath, 'utf8') : '';
    const curlArgs = shim
      ? readFileSync(curlLog, 'utf8')
          .split('@@end@@\n')
          .filter(Boolean)
          .map(call => call.split('\n').filter(Boolean))
      : [];
    return { ...result, curlArgs, requests, written };
  } finally {
    server.close();
    rmSync(dir, { force: true, recursive: true });
  }
}

/** No secret appears in the log except in its own `::add-mask::` line. */
function assertNoLeak({ stderr, stdout }, secrets = [TOKEN, OIDC_TOKEN, REQUEST_TOKEN]) {
  for (const secret of secrets) {
    assert.ok(!stderr.includes(secret), `stderr holds ${secret}`);
    for (const line of stdout.split('\n')) {
      if (line.includes(secret)) {
        assert.equal(line, `::add-mask::${secret}`);
      }
    }
  }
}

function errorLine(stdout) {
  return stdout.split('\n').find(line => line.startsWith('::error::'));
}

test('mint masks the token first, then writes the id and the token', async () => {
  const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.stdout.split('\n'), [
    `::add-mask::${OIDC_TOKEN}`,
    `::add-mask::${TOKEN}`,
    `STS issued deploy token ${TOKEN_ID}`,
    '',
  ]);
  assert.equal(result.written, `token_id=${TOKEN_ID}\ntoken=${TOKEN}\n`);
  assertNoLeak(result);
  const [oidc, mint] = result.requests;
  assert.deepEqual(oidc, {
    authorization: `Bearer ${REQUEST_TOKEN}`,
    body: '',
    contentType: undefined,
    method: 'GET',
    path: '/oidc',
    query: { 'api-version': '2.0', audience: AUDIENCE },
  });
  assert.deepEqual(mint, {
    authorization: `Bearer ${OIDC_TOKEN}`,
    body: '{}',
    contentType: 'application/json',
    method: 'POST',
    path: MINT_PATH,
    query: {},
  });
  assert.equal(result.requests.length, 2);
});

test('mint masks the token before it writes any step output', async () => {
  const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], {
    output: 'unwritable',
  });
  assert.notEqual(result.code, 0);
  assert.ok(result.stdout.split('\n').includes(`::add-mask::${TOKEN}`), result.stdout);
  assertNoLeak(result);
});

test("no bearer or token ever appears in curl's arguments", async () => {
  const mint = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], { shim: 'real' });
  assert.equal(mint.code, 0, mint.stdout);
  const revokeAnswers = stsAnswers(REVOKE_PATH, 200, { status: 'revoked', tokenId: TOKEN_ID });
  const revoke = await runAgainst(revokeAnswers, ['revoke', TOKEN_ID], { shim: 'real' });
  assert.equal(revoke.code, 0, revoke.stdout);
  const calls = [...mint.curlArgs, ...revoke.curlArgs];
  assert.equal(calls.length, 4);
  for (const call of calls) {
    for (const secret of [TOKEN, OIDC_TOKEN, REQUEST_TOKEN]) {
      assert.ok(!call.some(arg => arg.includes(secret)), `${secret} in ${call.join(' ')}`);
    }
    // The headers come from stdin, and plain HTTP is allowed only in test mode.
    assert.equal(call[call.indexOf('-H') + 1], '@-');
    assert.equal(call[call.indexOf('--proto') + 1], '=http,https');
  }
});

test('outside test mode every request goes over HTTPS to STS and STS_URL is ignored', async () => {
  const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], {
    env: { STS_DEPLOY_TOKEN_TEST: undefined },
    shim: 'fake',
  });
  assert.equal(result.code, 1);
  assert.equal(errorLine(result.stdout), '::error::STS is unreachable (curl exit 7)');
  assert.deepEqual(result.requests, []);
  const [oidc, mint] = result.curlArgs;
  assert.equal(oidc[oidc.indexOf('--proto') + 1], '=https');
  assert.equal(mint[mint.indexOf('--proto') + 1], '=https');
  assert.equal(mint.at(-1), `${AUDIENCE}${MINT_PATH}`);
});

test('test mode is refused inside GitHub Actions and calls nothing', async () => {
  const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], {
    env: { GITHUB_ACTIONS: 'true' },
  });
  assert.equal(result.code, 1);
  assert.equal(errorLine(result.stdout), '::error::STS_DEPLOY_TOKEN_TEST is for local tests only');
  assert.deepEqual(result.requests, []);
});

test('STS_ENVIRONMENT staging asks for the staging audience and sends to staging STS', async () => {
  const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], {
    env: { STS_DEPLOY_TOKEN_TEST: undefined, STS_ENVIRONMENT: 'staging' },
    shim: 'fake',
  });
  assert.equal(result.code, 1);
  const [oidc, mint] = result.curlArgs;
  assert.ok(oidc.includes(`audience=${STAGING_AUDIENCE}`), oidc.join(' '));
  assert.equal(mint.at(-1), `${STAGING_AUDIENCE}${MINT_PATH}`);
});

for (const value of [undefined, '', 'Production', 'development']) {
  test(`STS_ENVIRONMENT ${JSON.stringify(value)} is refused before any call`, async () => {
    const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], {
      env: { STS_ENVIRONMENT: value },
    });
    assert.equal(result.code, 1);
    assert.equal(
      errorLine(result.stdout),
      '::error::STS_ENVIRONMENT must be production or staging'
    );
    assert.deepEqual(result.requests, []);
  });
}

const REFUSALS = [
  {
    body: { reason: 'identity_rejected', status: 'denied' },
    detail: 'HTTP 401: denied, identity_rejected',
    status: 401,
  },
  {
    body: { reason: 'rate_limited', retryAfterSeconds: 1200, status: 'limited' },
    detail: 'HTTP 429: limited, rate_limited, retry after 1200 s',
    status: 429,
  },
  {
    body: { retryAfterSeconds: 30, status: 'unavailable' },
    detail: 'HTTP 503: unavailable, retry after 30 s',
    status: 503,
  },
  { body: { status: 'invalid_request' }, detail: 'HTTP 400: invalid_request', status: 400 },
];

for (const { body, detail, status } of REFUSALS) {
  test(`mint fails with the refusal ${body.status}`, async () => {
    const result = await runAgainst(stsAnswers(MINT_PATH, status, body), ['mint']);
    assert.equal(result.code, 1);
    assert.equal(errorLine(result.stdout), `::error::STS issued no deploy token (${detail})`);
    assert.equal(result.written, '');
    assertNoLeak(result);
  });
}

// `masked`: the answer holds a usable one-line token, which is masked before the refusal.
const MALFORMED = [
  {
    body: { ...ISSUED, tokenId: `${TOKEN}0123` },
    masked: true,
    name: 'a token id that is not 32 hex',
  },
  {
    body: { ...ISSUED, tokenId: `${TOKEN_ID}\n` },
    masked: true,
    name: 'a token id with a final newline',
  },
  {
    body: { ...ISSUED, tokenId: TOKEN_ID.toUpperCase() },
    masked: true,
    name: 'an upper-case token id',
  },
  { body: { ...ISSUED, tokenId: undefined }, masked: true, name: 'no token id' },
  { body: { ...ISSUED, token: '' }, name: 'an empty token' },
  { body: { ...ISSUED, token: `${TOKEN}\ntoken_id=${TOKEN_ID}` }, name: 'a two-line token' },
  { body: { ...ISSUED, token: `${TOKEN}\n` }, name: 'a token with a final newline' },
  { body: { ...ISSUED, token: `${TOKEN} x` }, name: 'a token with a space' },
  { body: { ...ISSUED, token: 42 }, name: 'a token that is not a string' },
  {
    body: { ...ISSUED, status: 'issued' },
    detail: 'issued',
    masked: true,
    name: 'another status',
  },
  { body: `token=${TOKEN}`, name: 'a body that is not JSON' },
  { body: [ISSUED], name: 'an array' },
  { body: '', name: 'an empty body' },
  { body: ISSUED, masked: true, name: 'an ok answer with HTTP 201', status: 201 },
  {
    body: { reason: TOKEN, status: 'denied' },
    detail: 'denied',
    name: 'a reason that is not a word',
  },
];

for (const { body, detail = 'malformed answer', masked = false, name, status = 200 } of MALFORMED) {
  test(`mint refuses ${name} and never prints the token`, async () => {
    const result = await runAgainst(stsAnswers(MINT_PATH, status, body), ['mint']);
    assert.equal(result.code, 1);
    assert.equal(
      errorLine(result.stdout),
      `::error::STS issued no deploy token (HTTP ${status}: ${detail})`
    );
    const lines = result.stdout.split('\n');
    assert.equal(lines.includes(`::add-mask::${TOKEN}`), masked, result.stdout);
    if (masked) {
      assert.ok(lines.indexOf(`::add-mask::${TOKEN}`) < lines.indexOf(errorLine(result.stdout)));
    } else {
      assert.ok(!result.stdout.includes(TOKEN), result.stdout);
    }
    assert.equal(result.written, '');
    assertNoLeak(result);
  });
}

test('mint fails when STS is unreachable', async () => {
  const closed = await stub({});
  closed.server.close();
  const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], {
    env: { STS_URL: closed.url },
  });
  assert.equal(result.code, 1);
  assert.equal(errorLine(result.stdout), '::error::STS is unreachable (curl exit 7)');
  assert.equal(result.written, '');
  assertNoLeak(result);
});

for (const missing of ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL']) {
  test(`mint fails without ${missing} and calls nothing`, async () => {
    const result = await runAgainst(stsAnswers(MINT_PATH, 200, ISSUED), ['mint'], {
      env: { [missing]: undefined },
    });
    assert.equal(result.code, 1);
    assert.equal(
      errorLine(result.stdout),
      '::error::No GitHub OIDC token: the job needs permissions: id-token: write'
    );
    assert.deepEqual(result.requests, []);
  });
}

test('mint fails when GitHub refuses the OIDC token', async () => {
  const answers = { '/oidc': { body: { message: 'denied' }, status: 403 } };
  const result = await runAgainst(answers, ['mint']);
  assert.equal(result.code, 1);
  assert.equal(errorLine(result.stdout), '::error::GitHub did not issue an OIDC token');
  assert.deepEqual(
    result.requests.map(request => request.path),
    ['/oidc']
  );
});

const BAD_OIDC = [
  { body: {}, name: 'no value' },
  { body: { value: 42 }, name: 'a value that is not a string' },
  { body: { value: '' }, name: 'an empty value' },
  { body: { value: `${OIDC_TOKEN}\nx` }, name: 'a two-line value' },
  { body: { value: `${OIDC_TOKEN}\n` }, name: 'a value with a final newline' },
  { body: 'not json', name: 'a body that is not JSON' },
];

for (const { body, name } of BAD_OIDC) {
  test(`mint stops when GitHub answers 200 with ${name}`, async () => {
    const answers = { ...stsAnswers(MINT_PATH, 200, ISSUED), '/oidc': { body, status: 200 } };
    const result = await runAgainst(answers, ['mint']);
    assert.equal(result.code, 1);
    assert.equal(errorLine(result.stdout), '::error::GitHub answered without an OIDC token');
    assert.deepEqual(
      result.requests.map(request => request.path),
      ['/oidc']
    );
    assertNoLeak(result);
  });
}

// jq reads a stream: each answer must be exactly one JSON value, or two concatenated objects would
// each pass the checks and print two values (a second, unmasked token and extra output lines).
const SECOND_TOKEN = 'cfat_SECONDinjected456';
const SECOND_ID = 'f'.repeat(32);

function concatenated(...values) {
  return values.map(value => JSON.stringify(value)).join('\n');
}

const CONCATENATED_MINTS = [
  {
    body: concatenated(ISSUED, { ...ISSUED, token: SECOND_TOKEN, tokenId: SECOND_ID }),
    name: 'a second token',
  },
  {
    body: concatenated(ISSUED, { status: 'ok', tokenId: `${SECOND_ID}\ntoken=${SECOND_TOKEN}` }),
    name: 'a second token id that injects an output line',
  },
  { body: concatenated(ISSUED, ISSUED), name: 'the same answer twice' },
];

for (const { body, name } of CONCATENATED_MINTS) {
  test(`mint refuses two concatenated answers with ${name}, unmasked and unwritten`, async () => {
    const result = await runAgainst(stsAnswers(MINT_PATH, 200, body), ['mint']);
    assert.equal(result.code, 1);
    assert.equal(
      errorLine(result.stdout),
      '::error::STS issued no deploy token (HTTP 200: malformed answer)'
    );
    for (const secret of [TOKEN, SECOND_TOKEN]) {
      assert.ok(!result.stdout.includes(secret), result.stdout);
      assert.ok(!result.stderr.includes(secret), result.stderr);
    }
    assert.equal(result.written, '');
  });
}

test('revoke refuses two concatenated answers', async () => {
  const body = concatenated(
    { status: 'revoked', tokenId: TOKEN_ID },
    { status: 'revoked', tokenId: TOKEN_ID }
  );
  const result = await runAgainst(stsAnswers(REVOKE_PATH, 200, body), ['revoke', TOKEN_ID]);
  assert.equal(result.code, 1);
  assert.equal(
    errorLine(result.stdout),
    `::error::STS did not revoke deploy token ${TOKEN_ID} (HTTP 200: malformed answer)`
  );
});

test('mint stops when GitHub answers two concatenated OIDC objects, masking neither', async () => {
  const body = concatenated({ value: OIDC_TOKEN }, { value: `${OIDC_TOKEN}.second` });
  const answers = { ...stsAnswers(MINT_PATH, 200, ISSUED), '/oidc': { body, status: 200 } };
  const result = await runAgainst(answers, ['mint']);
  assert.equal(result.code, 1);
  assert.equal(errorLine(result.stdout), '::error::GitHub answered without an OIDC token');
  assert.ok(!result.stdout.includes(OIDC_TOKEN), result.stdout);
  assert.ok(!result.stderr.includes(OIDC_TOKEN), result.stderr);
  assert.deepEqual(
    result.requests.map(request => request.path),
    ['/oidc']
  );
  assert.equal(result.written, '');
});

test('revoke sends the id with a fresh OIDC token', async () => {
  const answers = stsAnswers(REVOKE_PATH, 200, { status: 'revoked', tokenId: TOKEN_ID });
  const result = await runAgainst(answers, ['revoke', TOKEN_ID]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stdout.split('\n').at(-2), `STS revoked deploy token ${TOKEN_ID}`);
  const [oidc, revoke] = result.requests;
  assert.equal(oidc.query.audience, AUDIENCE);
  assert.deepEqual(revoke, {
    authorization: `Bearer ${OIDC_TOKEN}`,
    body: JSON.stringify({ tokenId: TOKEN_ID }),
    contentType: 'application/json',
    method: 'POST',
    path: REVOKE_PATH,
    query: {},
  });
  assertNoLeak(result);
});

const REVOKE_FAILURES = [
  { body: { status: 'not_found' }, detail: 'HTTP 404: not_found', status: 404 },
  {
    body: { reason: 'identity_rejected', status: 'denied' },
    detail: 'HTTP 401: denied, identity_rejected',
    status: 401,
  },
  {
    body: { retryAfterSeconds: 45, status: 'unavailable' },
    detail: 'HTTP 503: unavailable, retry after 45 s',
    status: 503,
  },
  {
    body: { status: 'revoked', tokenId: 'f'.repeat(32) },
    detail: 'HTTP 200: malformed answer',
    status: 200,
  },
];

for (const { body, detail, status } of REVOKE_FAILURES) {
  test(`revoke fails on ${detail}`, async () => {
    const result = await runAgainst(stsAnswers(REVOKE_PATH, status, body), ['revoke', TOKEN_ID]);
    assert.equal(result.code, 1);
    assert.equal(
      errorLine(result.stdout),
      `::error::STS did not revoke deploy token ${TOKEN_ID} (${detail})`
    );
  });
}

const INVALID_IDS = [
  '',
  'abc',
  TOKEN_ID.toUpperCase(),
  `${TOKEN_ID}0`,
  `${TOKEN_ID}\n`,
  `${TOKEN_ID}","x":"`,
];

for (const id of INVALID_IDS) {
  test(`revoke refuses the id ${JSON.stringify(id)} locally`, async () => {
    const answers = stsAnswers(REVOKE_PATH, 200, { status: 'revoked', tokenId: TOKEN_ID });
    const result = await runAgainst(answers, ['revoke', id]);
    assert.equal(result.code, 1);
    assert.equal(errorLine(result.stdout), '::error::Not a deploy token id; nothing was sent');
    assert.deepEqual(result.requests, []);
  });
}

for (const args of [[], ['mint', 'extra'], ['revoke'], ['revoke', TOKEN_ID, 'extra'], ['rotate']]) {
  test(`refuses the arguments ${JSON.stringify(args)}`, async () => {
    const result = await runAgainst({}, args);
    assert.equal(result.code, 1);
    assert.match(errorLine(result.stdout), /^::error::Usage: /u);
    assert.deepEqual(result.requests, []);
  });
}
