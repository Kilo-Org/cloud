import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveVault, resolveVercelContexts, setVaultValue } from './shared.js';

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
if (args[0] === 'item' && args[1] === 'list') {
  const items = process.env.FAKE_OP_EXISTING
    ? [{ id: 'existing-id', title: 'TEST_SECRET' }]
    : [];
  process.stdout.write(JSON.stringify(items));
} else if (args[0] === 'item' && args[1] === 'get') {
  process.stdout.write(JSON.stringify({
    id: 'existing-id',
    title: 'TEST_SECRET',
    category: 'PASSWORD',
    fields: [
      { id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: 'old-value' },
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

async function captureOpInvocations(existing: boolean): Promise<Invocation[]> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'web-env-op-test-'));
  const logFile = path.join(directory, 'op.jsonl');
  writeFileSync(path.join(directory, 'op'), FAKE_OP, { mode: 0o700 });

  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_OP_LOG;
  const originalExisting = process.env.FAKE_OP_EXISTING;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.FAKE_OP_LOG = logFile;
  if (existing) process.env.FAKE_OP_EXISTING = '1';
  else delete process.env.FAKE_OP_EXISTING;

  try {
    await setVaultValue('vault-id', 'TEST_SECRET', 'secret-value');
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

void test('setVaultValue creates an item from a template without sending the secret through stdin', async () => {
  const invocations = await captureOpInvocations(false);
  const create = invocations.find(invocation => invocation.args[1] === 'create');
  assert.ok(create);
  assert.deepEqual(create.args, [
    'item',
    'create',
    '--template=/dev/fd/3',
    '--vault',
    'vault-id',
    '--format=json',
  ]);
  assert.equal(create.stdin, '');
  const item = JSON.parse(create.templateInput) as { title?: string; fields?: unknown[] };
  assert.equal(item.title, 'TEST_SECRET');
  assert.ok(item.fields?.some(field => JSON.stringify(field).includes('secret-value')));
});

void test('setVaultValue updates an item from a template without sending the secret through stdin', async () => {
  const invocations = await captureOpInvocations(true);
  const edit = invocations.find(invocation => invocation.args[1] === 'edit');
  assert.ok(edit);
  assert.deepEqual(edit.args, [
    'item',
    'edit',
    'existing-id',
    '--template=/dev/fd/3',
    '--vault',
    'vault-id',
    '--format=json',
  ]);
  assert.equal(edit.stdin, '');
  const item = JSON.parse(edit.templateInput) as { title?: string; fields?: unknown[] };
  assert.equal(item.title, 'TEST_SECRET');
  assert.ok(item.fields?.some(field => JSON.stringify(field).includes('secret-value')));
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
          error.message.includes('op vault get "Kilo Web ENV Production" --format=json')
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
          error.message.includes('op vault get "Kilo Web ENV Production" --format=json') &&
          error.message.includes('not currently signed in')
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
