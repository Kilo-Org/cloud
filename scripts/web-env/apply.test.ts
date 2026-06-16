import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyRemoteChanges, PartialRemoteFailureError } from './apply.js';
import type { OnePasswordAdapter } from './onepassword.js';
import type { VercelAdapter } from './vercel.js';

const values = {
  development: 'development-secret-value',
  staging: 'staging-secret-value',
  production: 'production-secret-value',
};

void test('remote apply stops on first failure and writes a value-free resume journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-env-apply-test-'));
  const calls: string[] = [];
  const vercel = {
    writeVariable: async (input: Parameters<VercelAdapter['writeVariable']>[0]) => {
      const id = `${input.project}/${input.environment}`;
      calls.push(id);
      if (id === 'kilocode-app/staging') throw new Error('provider included a secret');
    },
  };
  const onePassword = {
    writeProductionValue: async () => {
      calls.push('1Password');
    },
  };

  try {
    let failure: PartialRemoteFailureError | undefined;
    try {
      await applyRemoteChanges({
        repoRoot: root,
        mode: 'update',
        variableName: 'API_TOKEN',
        sensitive: true,
        values,
        vercel,
        onePassword,
        now: () => new Date('2026-06-16T12:00:00.000Z'),
      });
    } catch (error) {
      if (error instanceof PartialRemoteFailureError) failure = error;
      else throw error;
    }
    assert.ok(failure);
    assert.deepEqual(calls, [
      'kilocode-app/development',
      'kilocode-global-app/development',
      'kilocode-app/staging',
    ]);
    assert.deepEqual(failure.journal.completed, [
      'kilocode-app/development',
      'kilocode-global-app/development',
    ]);
    assert.equal(failure.journal.failed, 'kilocode-app/staging');
    const journal = await readFile(path.join(root, failure.journalPath), 'utf8');
    assert.equal(journal.includes('secret-value'), false);
    assert.equal(journal.includes('provider included a secret'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('non-sensitive apply skips 1Password after writing the full matrix', async () => {
  const calls: string[] = [];
  const vercel = {
    writeVariable: async (input: Parameters<VercelAdapter['writeVariable']>[0]) => {
      calls.push(`${input.project}/${input.environment}/${input.expectedType}`);
    },
  };
  const onePassword = {
    writeProductionValue: async () => {
      calls.push('1Password');
    },
  };
  await applyRemoteChanges({
    repoRoot: '/unused',
    mode: 'add',
    variableName: 'FEATURE_FLAG',
    sensitive: false,
    values,
    vercel,
    onePassword,
  });
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.endsWith('/encrypted')));
  assert.equal(calls.includes('1Password'), false);
});

void test('sensitive apply sends only the production value to 1Password', async () => {
  const received: string[] = [];
  const vercel = {
    writeVariable: async () => undefined,
  };
  const onePassword = {
    writeProductionValue: async (
      ...input: Parameters<OnePasswordAdapter['writeProductionValue']>
    ) => {
      received.push(input[2]);
    },
  };
  await applyRemoteChanges({
    repoRoot: '/unused',
    mode: 'update',
    variableName: 'API_TOKEN',
    sensitive: true,
    values,
    vercel,
    onePassword,
  });
  assert.deepEqual(received, ['production-secret-value']);
});
