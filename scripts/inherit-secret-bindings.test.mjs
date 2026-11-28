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
const SCRIPT = path.join(import.meta.dirname, 'ci', 'inherit-secret-bindings.mjs');
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const STORE = 'fedcba9876543210fedcba9876543210';
const TOKEN = 'cfat_deploytoken123';
const VERSION = '11111111-2222-4333-8444-555555555555';
const OLDER = '11111111-2222-4333-8444-000000000000';

/** A Worker config in JSONC, as the repository commits it. */
function config({ staging = false, unsafe = false } = {}) {
  const bindings = `[
      { "binding": "API_KEY", "store_id": "${STORE}", "secret_name": "API_KEY" },
      { "binding": "DB_URL", "store_id": "${STORE}", "secret_name": "DB_URL" }, // trailing comma
    ]`;
  return `{
  // a comment
  "name": "demo",
  "account_id": "${ACCOUNT}",
  ${staging ? '' : `"secrets_store_secrets": ${bindings},`}
  ${unsafe ? '"unsafe": { "bindings": [] },' : ''}
  "env": {
    "staging": {
      ${staging ? `"secrets_store_secrets": ${bindings},` : ''}
      "vars": { "A": "1" }
    }
  }
}`;
}

function version(bindings) {
  return { success: true, result: { id: VERSION, number: 3, resources: { bindings } } };
}

const MATCHING = [
  { type: 'secrets_store_secret', name: 'API_KEY', store_id: STORE, secret_name: 'API_KEY' },
  { type: 'secrets_store_secret', name: 'DB_URL', store_id: STORE, secret_name: 'DB_URL' },
  { type: 'plain_text', name: 'A', text: 'value' },
];

/** A stand-in for Cloudflare's Workers API. It records every request. */
async function stub(worker, { list, bindings }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const base = `/accounts/${ACCOUNT}/workers/scripts/${worker}/versions`;
    let body = { success: false, errors: [{ code: 10007 }] };
    let status = 404;
    if (request.url === `${base}?per_page=100`) {
      [status, body] = [200, { success: true, result: { items: list } }];
    } else if (request.url === `${base}/${VERSION}`) {
      [status, body] = [200, version(bindings)];
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function run(source, environment, answers, { worker = 'demo', env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'inherit-bindings-'));
  const file = path.join(dir, 'wrangler.jsonc');
  writeFileSync(file, source);
  const { requests, server, url } = await stub(worker, answers);
  try {
    const result = await execFileAsync('node', [SCRIPT, file, environment], {
      env: {
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_API_URL: url,
        INHERIT_BINDINGS_TEST: '1',
        ...env,
      },
    }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      error => ({ code: error.code, stdout: error.stdout })
    );
    return { ...result, requests, written: readFileSync(file, 'utf8') };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const LIST = [
  { id: VERSION, number: 3 },
  { id: OLDER, number: 2 },
];

test('rewrites matching Secrets Store bindings into inherited ones', async () => {
  const result = await run(config(), 'production', { list: LIST, bindings: MATCHING });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(
    result.stdout,
    `${result.stdout.split(':')[0]}: production inherits API_KEY, DB_URL from demo version 3 (${VERSION})\n`
  );
  const written = JSON.parse(result.written);
  assert.equal(written.secrets_store_secrets, undefined);
  assert.deepEqual(written.unsafe, {
    bindings: [
      { name: 'API_KEY', type: 'inherit' },
      { name: 'DB_URL', type: 'inherit' },
    ],
  });
  assert.deepEqual(written.env.staging, { vars: { A: '1' } }, 'the other environment is untouched');
  assert.deepEqual(
    result.requests.map(request => request.url),
    [
      `/accounts/${ACCOUNT}/workers/scripts/demo/versions?per_page=100`,
      `/accounts/${ACCOUNT}/workers/scripts/demo/versions/${VERSION}`,
    ]
  );
  assert.ok(result.requests.every(request => request.authorization === `Bearer ${TOKEN}`));
  assert.ok(!result.stdout.includes(TOKEN));
});

test('staging reads env.staging and the <name>-staging Worker', async () => {
  const result = await run(
    config({ staging: true }),
    'staging',
    { list: LIST, bindings: MATCHING },
    { worker: 'demo-staging' }
  );
  assert.equal(result.code, 0, result.stdout);
  const written = JSON.parse(result.written);
  assert.equal(written.env.staging.secrets_store_secrets, undefined);
  assert.equal(written.env.staging.unsafe.bindings.length, 2);
  assert.equal(written.unsafe, undefined);
});

test('a config without Secrets Store bindings stays as it is and calls nothing', async () => {
  const source = config({ staging: true });
  const result = await run(source, 'production', { list: LIST, bindings: MATCHING });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /no Secrets Store bindings for production; unchanged/);
  assert.equal(result.written, source);
  assert.deepEqual(result.requests, []);
});

for (const [name, bindings, detail] of [
  [
    'a missing binding',
    MATCHING.slice(1),
    'API_KEY: missing there; inheriting it fails with 10057',
  ],
  [
    'another secret',
    [{ ...MATCHING[0], secret_name: 'OTHER' }, MATCHING[1]],
    'API_KEY: secret_name differs',
  ],
  [
    'another store',
    [{ ...MATCHING[0], store_id: 'f'.repeat(32) }, MATCHING[1]],
    'store_id differs',
  ],
  [
    'another type',
    [{ type: 'secret_text', name: 'API_KEY' }, MATCHING[1]],
    'is a secret_text binding',
  ],
]) {
  test(`fails on ${name} and leaves the config unchanged`, async () => {
    const source = config();
    const result = await run(source, 'production', { list: LIST, bindings });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^::error::.*DEPLOY_TOKEN_SOURCE secret/);
    assert.ok(result.stdout.includes(detail), result.stdout);
    assert.equal(result.written, source);
  });
}

test('fails closed when the list does not start with the newest version', async () => {
  const result = await run(config(), 'production', {
    list: [
      { id: OLDER, number: 2 },
      { id: VERSION, number: 3 },
    ],
    bindings: MATCHING,
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /does not start with the newest version/);
});

test('fails for a new Worker with Secrets Store bindings (Cloudflare knows no version)', async () => {
  const result = await run(
    config(),
    'production',
    { list: LIST, bindings: MATCHING },
    {
      worker: 'another-worker',
    }
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /HTTP 404, Cloudflare error 10007/);
});

test('refuses a config that already has an unsafe block', async () => {
  const source = config({ unsafe: true });
  const result = await run(source, 'production', { list: LIST, bindings: MATCHING });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /has an unsafe block/);
  assert.equal(result.written, source);
});

test('test mode is refused inside GitHub Actions and calls nothing', async () => {
  const result = await run(
    config(),
    'production',
    { list: LIST, bindings: MATCHING },
    {
      env: { GITHUB_ACTIONS: 'true' },
    }
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /INHERIT_BINDINGS_TEST is for local tests only/);
  assert.deepEqual(result.requests, []);
});

test('refuses an environment other than production or staging', async () => {
  const result = await run(config(), 'development', { list: LIST, bindings: MATCHING });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /usage:/);
});
