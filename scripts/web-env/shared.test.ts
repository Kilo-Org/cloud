import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  redeployLatest,
  resolveVault,
  resolveVercelContexts,
  setVaultValue,
  stripSurroundingQuotes,
  type VaultEnvironment,
} from './shared.js';

// These tests mutate shared process.env (PATH and FAKE_OP_*) and restore it in a
// `finally`. That is only safe because node:test runs the top-level tests in a
// file sequentially — do not mark them `concurrent` without isolating env per test.

type Invocation = {
  args: string[];
  stdin: string;
  templateInput: string;
};

const FAKE_OP = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let templateInput = '';
try {
  templateInput = fs.readFileSync(3, 'utf8');
} catch {}
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_OP_LOG, JSON.stringify({ args, stdin, templateInput }) + '\\n');
if (args[0] === 'account' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([
    { url: 'kilocode.1password.com', account_uuid: 'kilocode-account-id' }
  ]));
} else if (args[0] === 'vault' && args[1] === 'get') {
  process.stdout.write(JSON.stringify({ id: 'vault-id' }));
} else if (args[0] === 'item' && args[1] === 'list') {
  const items = process.env.FAKE_OP_EXISTING !== 'none'
    ? [{ id: 'existing-id', title: 'TEST_SECRET' }]
    : [];
  process.stdout.write(JSON.stringify(items));
} else if (args[0] === 'item' && args[1] === 'get') {
  const passwordFields = process.env.FAKE_OP_EXISTING === 'production'
    ? [{ id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: 'old-production-value' }]
    : [{ id: 'generated-staging-id', label: 'password (staging)', type: 'CONCEALED', value: 'old-staging-value' }];
  process.stdout.write(JSON.stringify({
    id: 'existing-id',
    title: 'TEST_SECRET',
    category: 'PASSWORD',
    fields: [
      ...passwordFields,
      { id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: '' }
    ],
    sections: []
  }));
} else if (args[0] === 'item' && (args[1] === 'create' || args[1] === 'edit')) {
  process.stdout.write(templateInput || stdin);
} else {
  process.exitCode = 1;
}
`;

const FAKE_PNPM_VERCEL_AUTH_FAILURE = `#!/usr/bin/env node
process.stderr.write('Error: No existing credentials found. Run vercel login.\\n');
process.exitCode = 1;
`;

const FAKE_OP_AUTH_FAILURE = `#!/usr/bin/env node
process.stderr.write('You are not currently signed in to a 1Password account.\\n');
process.exitCode = 1;
`;

const FAKE_PNPM_REDEPLOY = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_VERCEL_LOG, JSON.stringify(args) + '\\n');
if (args[2] === 'list') {
  process.stdout.write(JSON.stringify({
    deployments: [
      { url: 'latest-staging.example.vercel.app', state: 'READY' },
      { url: 'older-staging.example.vercel.app', state: 'READY' }
    ]
  }));
} else if (args[2] === 'redeploy') {
  process.stdout.write('https://new-staging.example.vercel.app');
} else {
  process.exitCode = 1;
}
`;

async function captureOpInvocations(
  existing: 'none' | VaultEnvironment,
  environment: VaultEnvironment
): Promise<Invocation[]> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-env-op-test-'));
  const logFile = path.join(directory, 'op.jsonl');
  writeFileSync(path.join(directory, 'op'), FAKE_OP, { mode: 0o700 });

  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_OP_LOG;
  const originalExisting = process.env.FAKE_OP_EXISTING;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.FAKE_OP_LOG = logFile;
  process.env.FAKE_OP_EXISTING = existing;

  try {
    await setVaultValue(
      { accountId: 'account-id', vaultId: 'vault-id' },
      'TEST_SECRET',
      `new-${environment}-value`,
      environment
    );
    return readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Invocation);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_OP_LOG;
    else process.env.FAKE_OP_LOG = originalLog;
    if (originalExisting === undefined) delete process.env.FAKE_OP_EXISTING;
    else process.env.FAKE_OP_EXISTING = originalExisting;
    rmSync(directory, { recursive: true, force: true });
  }
}

void test('stripSurroundingQuotes removes one matching outer quote pair', () => {
  assert.equal(stripSurroundingQuotes('"secret"'), 'secret');
  assert.equal(stripSurroundingQuotes("'secret'"), 'secret');
  assert.equal(stripSurroundingQuotes('secret'), 'secret');
  assert.equal(stripSurroundingQuotes('"already"quoted"'), 'already"quoted');
  assert.equal(stripSurroundingQuotes('""'), '');
  assert.equal(stripSurroundingQuotes('"'), '"');
  assert.equal(stripSurroundingQuotes(`"line\nwith\nnewlines"`), 'line\nwith\nnewlines');
  assert.equal(stripSurroundingQuotes(`'keeps "inner" double'`), 'keeps "inner" double');
  assert.equal(stripSurroundingQuotes(`"mismatched'`), `"mismatched'`);
});

void test('redeployLatest redeploys the latest ready deployment for the target environment', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-env-vercel-test-'));
  const logFile = path.join(directory, 'vercel.jsonl');
  writeFileSync(path.join(directory, 'pnpm'), FAKE_PNPM_REDEPLOY, { mode: 0o700 });
  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_VERCEL_LOG;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.FAKE_VERCEL_LOG = logFile;

  try {
    assert.equal(
      await redeployLatest({ project: 'kilocode-app', orgId: 'org-id', cwd: directory }, 'staging'),
      'https://new-staging.example.vercel.app'
    );
    const invocations = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[]);
    assert.deepEqual(invocations[0]?.slice(0, 10), [
      'dlx',
      'vercel@53.3.1',
      'list',
      'kilocode-app',
      '--environment',
      'staging',
      '--status',
      'READY',
      '--format=json',
      '--scope',
    ]);
    assert.deepEqual(invocations[1]?.slice(0, 7), [
      'dlx',
      'vercel@53.3.1',
      'redeploy',
      'latest-staging.example.vercel.app',
      '--target',
      'staging',
      '--scope',
    ]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_VERCEL_LOG;
    else process.env.FAKE_VERCEL_LOG = originalLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('setVaultValue creates an item from a template without sending the secret through stdin', async () => {
  const invocations = await captureOpInvocations('none', 'production');
  const create = invocations.find(invocation => invocation.args[1] === 'create');
  assert.ok(create);
  assert.deepEqual(create.args, [
    'item',
    'create',
    '--template=/dev/fd/3',
    '--vault',
    'vault-id',
    '--account',
    'account-id',
    '--format=json',
  ]);
  assert.equal(create.stdin, '');
  const item = JSON.parse(create.templateInput) as {
    title?: string;
    fields?: Array<{ id?: string; label?: string; value?: string }>;
  };
  assert.equal(item.title, 'TEST_SECRET');
  assert.equal(item.fields?.find(field => field.id === 'password')?.value, 'new-production-value');
  assert.equal(
    item.fields?.find(field => field.label === 'password (staging)'),
    undefined
  );
});

void test('setVaultValue updates an item from a template without sending the secret through stdin', async () => {
  const invocations = await captureOpInvocations('production', 'production');
  const edit = invocations.find(invocation => invocation.args[1] === 'edit');
  assert.ok(edit);
  assert.deepEqual(edit.args, [
    'item',
    'edit',
    'existing-id',
    '--template=/dev/fd/3',
    '--vault',
    'vault-id',
    '--account',
    'account-id',
    '--format=json',
  ]);
  assert.equal(edit.stdin, '');
  const item = JSON.parse(edit.templateInput) as {
    title?: string;
    fields?: Array<{ id?: string; label?: string; value?: string }>;
  };
  assert.equal(item.title, 'TEST_SECRET');
  assert.equal(item.fields?.find(field => field.id === 'password')?.value, 'new-production-value');
});

void test('setVaultValue creates a staging-only item without a production value', async () => {
  const invocations = await captureOpInvocations('none', 'staging');
  const create = invocations.find(invocation => invocation.args[1] === 'create');
  assert.ok(create);
  const item = JSON.parse(create.templateInput) as {
    fields?: Array<{ id?: string; label?: string; type?: string; value?: string }>;
  };
  assert.deepEqual(
    item.fields?.find(field => field.label === 'password (staging)'),
    {
      id: 'password-staging',
      label: 'password (staging)',
      type: 'CONCEALED',
      value: 'new-staging-value',
    }
  );
  assert.equal(
    item.fields?.find(field => field.id === 'password'),
    undefined
  );
});

void test('setVaultValue adds staging to an item that only has production', async () => {
  const invocations = await captureOpInvocations('production', 'staging');
  const edit = invocations.find(invocation => invocation.args[1] === 'edit');
  assert.ok(edit);
  const item = JSON.parse(edit.templateInput) as {
    fields?: Array<{ id?: string; label?: string; value?: string }>;
  };
  assert.equal(item.fields?.find(field => field.id === 'password')?.value, 'old-production-value');
  assert.equal(
    item.fields?.find(field => field.label === 'password (staging)')?.value,
    'new-staging-value'
  );
});

void test('setVaultValue updates an existing staging field by label', async () => {
  const invocations = await captureOpInvocations('staging', 'staging');
  const edit = invocations.find(invocation => invocation.args[1] === 'edit');
  assert.ok(edit);
  const item = JSON.parse(edit.templateInput) as {
    fields?: Array<{ id?: string; label?: string; value?: string }>;
  };
  const staging = item.fields?.find(field => field.label === 'password (staging)');
  assert.equal(staging?.id, 'generated-staging-id');
  assert.equal(staging?.value, 'new-staging-value');
});

void test('setVaultValue adds production to an item that only has staging', async () => {
  const invocations = await captureOpInvocations('staging', 'production');
  const edit = invocations.find(invocation => invocation.args[1] === 'edit');
  assert.ok(edit);
  const item = JSON.parse(edit.templateInput) as {
    fields?: Array<{ id?: string; label?: string; value?: string }>;
  };
  assert.equal(item.fields?.find(field => field.id === 'password')?.value, 'new-production-value');
  assert.equal(
    item.fields?.find(field => field.label === 'password (staging)')?.value,
    'old-staging-value'
  );
});

void test('resolveVault selects the kilocode account before resolving the vault', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-env-op-test-'));
  const logFile = path.join(directory, 'op.jsonl');
  writeFileSync(path.join(directory, 'op'), FAKE_OP, { mode: 0o700 });
  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_OP_LOG;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.FAKE_OP_LOG = logFile;

  try {
    assert.deepEqual(resolveVault(), { accountId: 'kilocode-account-id', vaultId: 'vault-id' });
    const invocations = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Invocation);
    assert.deepEqual(invocations[0]?.args, ['account', 'list', '--format=json']);
    assert.deepEqual(invocations[1]?.args, [
      'vault',
      'get',
      'Kilo Web ENV Production',
      '--account',
      'kilocode-account-id',
      '--format=json',
    ]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_OP_LOG;
    else process.env.FAKE_OP_LOG = originalLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

void test(
  'resolveVault explains how to install and verify the 1Password CLI when op is missing',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux' },
  () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      assert.throws(
        () => resolveVault(),
        error =>
          error instanceof Error &&
          error.message.includes('1Password CLI (`op`) is not installed') &&
          error.message.includes('brew install 1password-cli') &&
          error.message.includes('/cli/get-started') &&
          error.message.includes('op signin') &&
          error.message.includes('op account list --format=json') &&
          error.message.includes(
            'op vault get "Kilo Web ENV Production" --account kilocode.1password.com --format=json'
          )
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  }
);

void test('resolveVercelContexts explains how to install and verify pnpm for Vercel checks', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-env-vercel-test-'));
  const originalPath = process.env.PATH;
  process.env.PATH = '';

  try {
    assert.throws(
      () => resolveVercelContexts(directory),
      error =>
        error instanceof Error &&
        error.message.includes('Vercel access checks require pnpm') &&
        error.message.includes('corepack enable') &&
        error.message.includes('pnpm dlx vercel@53.3.1 whoami --scope kilocode --format=json')
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('resolveVercelContexts explains how to fix Vercel authentication failures', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-env-vercel-test-'));
  writeFileSync(path.join(directory, 'pnpm'), FAKE_PNPM_VERCEL_AUTH_FAILURE, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;

  try {
    assert.throws(
      () => resolveVercelContexts(directory),
      error =>
        error instanceof Error &&
        error.message.includes('Could not verify Vercel access for the kilocode team') &&
        error.message.includes('pnpm dlx vercel@53.3.1 login') &&
        error.message.includes('pnpm dlx vercel@53.3.1 whoami --scope kilocode --format=json') &&
        error.message.includes('No existing credentials found')
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

void test(
  'resolveVault explains how to fix 1Password authentication or vault access failures',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux' },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'web-env-op-test-'));
    writeFileSync(path.join(directory, 'op'), FAKE_OP_AUTH_FAILURE, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ''}`;

    try {
      assert.throws(
        () => resolveVault(),
        error =>
          error instanceof Error &&
          error.message.includes('Could not verify 1Password access') &&
          error.message.includes('brew install 1password-cli') &&
          error.message.includes('/cli/get-started') &&
          error.message.includes('op signin') &&
          error.message.includes('op account list --format=json') &&
          error.message.includes(
            'op vault get "Kilo Web ENV Production" --account kilocode.1password.com --format=json'
          ) &&
          error.message.includes('not currently signed in')
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
