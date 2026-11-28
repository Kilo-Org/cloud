import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(import.meta.dirname, 'ci', 'r2-temp-credentials.sh');
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const PARENT = 'abcdefabcdefabcdefabcdefabcdef12';
const TOKEN = 'cfat_deploytoken123';
const KEY_ID = 'tempkeyid0123';
const SECRET = 'tempsecretSECRET456';
const SESSION = 'sessiontokenSESSION789';
const ISSUED = {
  success: true,
  errors: [],
  result: { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: SESSION },
};

/** A stand-in for Cloudflare's temp-access-credentials route. It records every request. */
async function stub(status, body) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      text += chunk;
    });
    request.on('end', () => {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        body: text,
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function run(status, body, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'r2-temp-'));
  const output = path.join(dir, 'output');
  writeFileSync(output, '');
  const { requests, server, url } = await stub(status, body);
  try {
    const defined = Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_API_URL: url,
        GITHUB_OUTPUT: output,
        R2_TEMP_CREDENTIALS_TEST: '1',
        RUNTIME_R2_ACCOUNT_ID: ACCOUNT,
        RUNTIME_R2_BUCKET: 'kilo-runtime',
        RUNTIME_R2_PARENT_ACCESS_KEY_ID: PARENT,
        RUNTIME_R2_PERMISSION: 'object-read-write',
        ...env,
      }).filter(([, value]) => value !== undefined)
    );
    const result = await execFileAsync('bash', [SCRIPT], { env: defined }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr })
    );
    return { ...result, requests, written: readFileSync(output, 'utf8') };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** No credential appears in the log except in its own `::add-mask::` line. */
function assertNoLeak({ stdout, stderr }) {
  for (const secret of [TOKEN, SECRET, SESSION]) {
    assert.ok(!stderr.includes(secret), `stderr holds ${secret}`);
    for (const line of stdout.split('\n')) {
      if (line.includes(secret)) assert.equal(line, `::add-mask::${secret}`);
    }
  }
}

test('asks for read-only credentials when the deploy asks for them', async () => {
  const result = await run(200, ISSUED, { RUNTIME_R2_PERMISSION: 'object-read-only' });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.requests[0].body).permission, 'object-read-only');
});

test('masks the secret and the session token, then writes the three outputs', async () => {
  const result = await run(200, ISSUED);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.stdout.split('\n'), [
    `::add-mask::${SECRET}`,
    `::add-mask::${SESSION}`,
    'R2 issued temporary credentials on kilo-runtime for 3600 s',
    '',
  ]);
  assert.equal(
    result.written,
    `access_key_id=${KEY_ID}\nsecret_access_key=${SECRET}\nsession_token=${SESSION}\n`
  );
  assertNoLeak(result);
  assert.equal(result.requests.length, 1);
  const [request] = result.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `/accounts/${ACCOUNT}/r2/temp-access-credentials`);
  assert.equal(request.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.body), {
    bucket: 'kilo-runtime',
    parentAccessKeyId: PARENT,
    permission: 'object-read-write',
    ttlSeconds: 3600,
    prefixes: ['runtime-artifacts/v1/'],
  });
});

for (const [name, status, body, detail] of [
  ['a refusal', 403, { success: false, errors: [{ code: 10000 }] }, 'HTTP 403, codes 10000'],
  [
    'an answer without a session token',
    200,
    { success: true, result: { accessKeyId: KEY_ID, secretAccessKey: SECRET } },
    'HTTP 200',
  ],
  ['a body that is not JSON', 200, 'not json', 'HTTP 200'],
  [
    'two concatenated answers',
    200,
    `${JSON.stringify(ISSUED)}${JSON.stringify(ISSUED)}`,
    'HTTP 200',
  ],
]) {
  test(`fails on ${name}, writes nothing and prints no credential`, async () => {
    const result = await run(status, body);
    assert.equal(result.code, 1);
    assert.equal(
      result.stdout.split('\n').find(line => line.startsWith('::error::')),
      `::error::R2 issued no temporary credentials (${detail})`
    );
    assert.equal(result.written, '');
    assertNoLeak(result);
  });
}

for (const [variable, value] of [
  ['RUNTIME_R2_PARENT_ACCESS_KEY_ID', undefined],
  ['RUNTIME_R2_PARENT_ACCESS_KEY_ID', 'not-an-id'],
  ['RUNTIME_R2_ACCOUNT_ID', undefined],
  ['RUNTIME_R2_BUCKET', 'Bad_Bucket'],
  ['CLOUDFLARE_API_TOKEN', undefined],
  ['GITHUB_OUTPUT', undefined],
  ['RUNTIME_R2_PERMISSION', undefined],
  ['RUNTIME_R2_PERMISSION', 'admin-read-write'],
]) {
  test(`refuses ${variable}=${String(value)} before any call`, async () => {
    const result = await run(200, ISSUED, { [variable]: value });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^::error::/);
    assert.deepEqual(result.requests, []);
  });
}

test('test mode is refused inside GitHub Actions and calls nothing', async () => {
  const result = await run(200, ISSUED, { GITHUB_ACTIONS: 'true' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /R2_TEMP_CREDENTIALS_TEST is for local tests only/);
  assert.deepEqual(result.requests, []);
});
