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

test('creates planned secrets concurrently across stores without re-listing them', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sync-output-'));
  const first = secretCreate('services/event-service', 'FIRST_SECRET');
  const second = secretCreate('services/model-eval-ingest', 'SECOND_SECRET');
  for (const create of [first, second]) {
    fs.mkdirSync(path.join(repoRoot, create.workerDir, '.wrangler'), { recursive: true });
  }

  const plan: EnvSyncPlan = {
    lanIp: undefined,
    devVarsChanges: [],
    envDevLocalChanges: [],
    envLocalAutoCreates: [],
    secretStoreWarnings: [],
    secretStoreAutoCreates: [first, second],
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
      runWrangler: async (_repoRoot, _workerDir, args, input) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active--;

        assert.ok(!args.includes('list'));
        assert.ok(input?.startsWith('value-for-'));
        assert.ok(!args.some(arg => arg.startsWith('value-for-')));
        created.push(args[args.indexOf('--name') + 1] ?? '');
        return { status: 0, stderr: '', stdout: '' };
      },
    });

    assert.equal(maxActive, 2);
    assert.deepEqual(created.sort(), ['FIRST_SECRET', 'SECOND_SECRET']);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
