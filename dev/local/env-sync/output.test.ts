import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { applyPlan } from './output';
import type { EnvSyncPlan, SecretStoreAutoCreate } from './types';

function secretCreate(workerDir: string, secretName: string): SecretStoreAutoCreate {
  return {
    workerDir,
    binding: {
      binding: secretName,
      store_id: 'store-id',
      secret_name: secretName,
    },
    sourceKey: secretName,
    value: `value-for-${secretName}`,
  };
}

test('creates missing secrets concurrently across stores and rechecks existing secrets', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sync-output-'));
  const existing = secretCreate('services/event-service', 'EXISTING_SECRET');
  const missing = secretCreate('services/model-eval-ingest', 'MISSING_SECRET');
  for (const create of [existing, missing]) {
    fs.mkdirSync(path.join(repoRoot, create.workerDir, '.wrangler'), { recursive: true });
  }

  const plan: EnvSyncPlan = {
    lanIp: undefined,
    devVarsChanges: [],
    envDevLocalChanges: [],
    envLocalAutoCreates: [],
    secretStoreWarnings: [],
    secretStoreAutoCreates: [existing, missing],
    consistencyWarnings: [],
    execWarnings: [],
    missingEnvLocal: false,
  };
  let active = 0;
  let maxActive = 0;
  const created: string[] = [];
  try {
    await applyPlan(plan, repoRoot, {
      concurrency: 2,
      missingSecretsOnly: true,
      runWrangler: async (_repoRoot, workerDir, args, input) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active--;

        if (args.includes('list')) {
          return {
            status: 0,
            stderr: '',
            stdout: workerDir === existing.workerDir ? 'EXISTING_SECRET\n' : '',
          };
        }
        assert.ok(input?.startsWith('value-for-'));
        assert.ok(!args.some(arg => arg.startsWith('value-for-')));
        created.push(args[args.indexOf('--name') + 1] ?? '');
        return { status: 0, stderr: '', stdout: '' };
      },
    });

    assert.equal(maxActive, 2);
    assert.deepEqual(created, ['MISSING_SECRET']);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
