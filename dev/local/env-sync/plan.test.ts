import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { computePlan } from './plan';

const workerDir = 'services/cloud-agent-next';

type TestRepo = {
  root: string;
  cleanup: () => void;
};

function writeFile(root: string, relPath: string, content: string): void {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function createRepo(files: Record<string, string>): TestRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sync-plan-'));
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(root, relPath, content);
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function createCloudAgentNextRepo(options: {
  envLocal?: string;
  devScript?: string;
  wranglerJsonc: string;
  devVars?: string;
}): TestRepo {
  const files: Record<string, string> = {
    '.env.local': options.envLocal ?? '',
    [`${workerDir}/package.json`]: JSON.stringify(
      { scripts: { dev: options.devScript ?? "wrangler dev --env 'dev'" } },
      null,
      2
    ),
    [`${workerDir}/wrangler.jsonc`]: options.wranglerJsonc,
    [`${workerDir}/.dev.vars.example`]: 'R2_ATTACHMENTS_BUCKET=""\n',
  };
  if (options.devVars !== undefined) {
    files[`${workerDir}/.dev.vars`] = options.devVars;
  }
  return createRepo(files);
}

function computeCloudAgentNextPlan(root: string) {
  const plan = computePlan(root, new Set(['cloud-agent-next']));
  assert.equal(plan.missingEnvLocal, false);
  return plan;
}

function withFakePnpm(output: string, fn: () => void): void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sync-bin-'));
  const oldPath = process.env.PATH;
  try {
    const pnpmPath = path.join(binDir, 'pnpm');
    fs.writeFileSync(pnpmPath, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\n`, 'utf-8');
    fs.chmodSync(pnpmPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
    fn();
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test('treats selected wrangler environment vars as satisfied without copying them', () => {
  const repo = createCloudAgentNextRepo({
    wranglerJsonc: `{
      "vars": {
        "R2_ATTACHMENTS_BUCKET": "cloud-agent-attachments"
      },
      "env": {
        "dev": {
          "vars": {
            "R2_ATTACHMENTS_BUCKET": "cloud-agent-attachments-dev"
          }
        }
      }
    }`,
  });
  try {
    const plan = computeCloudAgentNextPlan(repo.root);
    assert.deepEqual(plan.devVarsChanges, []);
  } finally {
    repo.cleanup();
  }
});

test('treats top-level wrangler vars as satisfied when no environment is selected', () => {
  const repo = createCloudAgentNextRepo({
    devScript: 'wrangler dev',
    devVars: '',
    wranglerJsonc: `{
      "vars": {
        "R2_ATTACHMENTS_BUCKET": "cloud-agent-attachments"
      },
      "env": {
        "dev": {
          "vars": {
            "R2_ATTACHMENTS_BUCKET": "cloud-agent-attachments-dev"
          }
        }
      }
    }`,
  });
  try {
    const plan = computeCloudAgentNextPlan(repo.root);
    assert.deepEqual(plan.devVarsChanges, []);
  } finally {
    repo.cleanup();
  }
});

test('writes example defaults to .dev.vars when they override wrangler vars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sync-plan-'));
  try {
    writeFile(root, '.env.local', '');
    writeFile(
      root,
      `${workerDir}/package.json`,
      JSON.stringify({ scripts: { dev: 'wrangler dev' } })
    );
    writeFile(
      root,
      `${workerDir}/wrangler.jsonc`,
      `{
        "vars": {
          "FLY_ORG_SLUG": "kilo-679"
        }
      }`
    );
    writeFile(root, `${workerDir}/.dev.vars.example`, 'FLY_ORG_SLUG=kilo-dev\n');

    const plan = computePlan(root, new Set(['cloud-agent-next']));
    assert.equal(plan.missingEnvLocal, false);
    assert.equal(plan.devVarsChanges.length, 1);
    const [change] = plan.devVarsChanges;
    assert.ok(change);
    assert.equal(change.isNew, true);
    assert.ok(change.newFileContent?.includes('FLY_ORG_SLUG=kilo-dev'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auto-creates event-service NEXTAUTH Secrets Store binding from .env.local', () => {
  const repo = createRepo({
    '.env.local': 'NEXTAUTH_SECRET=local-nextauth-secret\n',
    'services/event-service/package.json': JSON.stringify({ scripts: { dev: 'wrangler dev' } }),
    'services/event-service/wrangler.jsonc': `{
      "secrets_store_secrets": [
        {
          "binding": "NEXTAUTH_SECRET",
          "store_id": "store-id",
          "secret_name": "NEXTAUTH_SECRET_PROD"
        }
      ]
    }`,
  });
  try {
    withFakePnpm('', () => {
      const plan = computePlan(repo.root, new Set(['event-service']));
      assert.equal(plan.missingEnvLocal, false);
      assert.deepEqual(plan.secretStoreWarnings, []);
      assert.equal(plan.secretStoreAutoCreates.length, 1);
      assert.deepEqual(plan.secretStoreAutoCreates[0], {
        workerDir: 'services/event-service',
        binding: {
          binding: 'NEXTAUTH_SECRET',
          store_id: 'store-id',
          secret_name: 'NEXTAUTH_SECRET_PROD',
        },
        sourceKey: 'NEXTAUTH_SECRET',
        value: 'local-nextauth-secret',
      });
    });
  } finally {
    repo.cleanup();
  }
});

test('auto-creates kilo-chat gateway Secrets Store binding from kiloclaw dev vars', () => {
  const repo = createRepo({
    '.env.local': 'NEXTAUTH_SECRET=local-nextauth-secret\n',
    'services/kiloclaw/.dev.vars.example': 'GATEWAY_TOKEN_SECRET=dev-gateway-secret-kiloclaw\n',
    'services/kilo-chat/package.json': JSON.stringify({ scripts: { dev: 'wrangler dev' } }),
    'services/kilo-chat/wrangler.jsonc': `{
      "secrets_store_secrets": [
        {
          "binding": "NEXTAUTH_SECRET",
          "store_id": "store-id",
          "secret_name": "NEXTAUTH_SECRET_PROD"
        },
        {
          "binding": "GATEWAY_TOKEN_SECRET",
          "store_id": "store-id",
          "secret_name": "GATEWAY_TOKEN_SECRET"
        }
      ]
    }`,
  });
  try {
    withFakePnpm('NEXTAUTH_SECRET_PROD\n', () => {
      const plan = computePlan(repo.root, new Set(['kilo-chat']));
      assert.equal(plan.missingEnvLocal, false);
      assert.deepEqual(plan.secretStoreWarnings, []);
      assert.deepEqual(plan.secretStoreAutoCreates, [
        {
          workerDir: 'services/kilo-chat',
          binding: {
            binding: 'GATEWAY_TOKEN_SECRET',
            store_id: 'store-id',
            secret_name: 'GATEWAY_TOKEN_SECRET',
          },
          sourceKey: 'services/kiloclaw/.dev.vars.example:GATEWAY_TOKEN_SECRET',
          value: 'dev-gateway-secret-kiloclaw',
        },
      ]);
    });
  } finally {
    repo.cleanup();
  }
});

test('auto-creates Secrets Store binding from exact suffixed local dev vars before base fallback', () => {
  const repo = createRepo({
    '.env.local': 'GATEWAY_TOKEN_SECRET=base-secret\n',
    'services/kiloclaw/.dev.vars.example': [
      'GATEWAY_TOKEN_SECRET=dev-gateway-secret-kiloclaw',
      'GATEWAY_TOKEN_SECRET_DEV=dev-gateway-secret-kiloclaw-dev',
      '',
    ].join('\n'),
    'services/kilo-chat/package.json': JSON.stringify({ scripts: { dev: 'wrangler dev' } }),
    'services/kilo-chat/wrangler.jsonc': `{
      "secrets_store_secrets": [
        {
          "binding": "GATEWAY_TOKEN_SECRET",
          "store_id": "store-id",
          "secret_name": "GATEWAY_TOKEN_SECRET_DEV"
        }
      ]
    }`,
  });
  try {
    withFakePnpm('', () => {
      const plan = computePlan(repo.root, new Set(['kilo-chat']));
      assert.equal(plan.missingEnvLocal, false);
      assert.deepEqual(plan.secretStoreWarnings, []);
      assert.deepEqual(plan.secretStoreAutoCreates, [
        {
          workerDir: 'services/kilo-chat',
          binding: {
            binding: 'GATEWAY_TOKEN_SECRET',
            store_id: 'store-id',
            secret_name: 'GATEWAY_TOKEN_SECRET_DEV',
          },
          sourceKey: 'services/kiloclaw/.dev.vars.example:GATEWAY_TOKEN_SECRET_DEV',
          value: 'dev-gateway-secret-kiloclaw-dev',
        },
      ]);
    });
  } finally {
    repo.cleanup();
  }
});

test('does not execute unrelated @exec annotations while discovering filtered secret sources', () => {
  const repo = createRepo({
    '.env.local': '',
    'services/kiloclaw/.dev.vars.example': [
      '# @exec node -e console.log("exec-secret")',
      'DEV_CREATOR=',
      '',
    ].join('\n'),
    'services/kilo-chat/package.json': JSON.stringify({ scripts: { dev: 'wrangler dev' } }),
    'services/kilo-chat/.dev.vars.example': 'KILO_CHAT_URL=http://localhost:8787\n',
    'services/kilo-chat/wrangler.jsonc': `{
      "secrets_store_secrets": [
        {
          "binding": "DEV_CREATOR",
          "store_id": "store-id",
          "secret_name": "DEV_CREATOR"
        }
      ]
    }`,
  });
  try {
    withFakePnpm('', () => {
      const plan = computePlan(repo.root, new Set(['kilo-chat']));
      assert.equal(plan.missingEnvLocal, false);
      assert.deepEqual(plan.secretStoreAutoCreates, []);
      assert.deepEqual(plan.secretStoreWarnings, [
        {
          workerDir: 'services/kilo-chat',
          bindings: [
            {
              binding: 'DEV_CREATOR',
              store_id: 'store-id',
              secret_name: 'DEV_CREATOR',
            },
          ],
        },
      ]);
      assert.deepEqual(plan.execWarnings, []);
    });
  } finally {
    repo.cleanup();
  }
});

test('keeps .env.local values ahead of wrangler vars for local overrides', () => {
  const repo = createCloudAgentNextRepo({
    envLocal: 'R2_ATTACHMENTS_BUCKET=local-attachments\n',
    devVars: '',
    wranglerJsonc: `{
      "vars": {
        "R2_ATTACHMENTS_BUCKET": "cloud-agent-attachments"
      },
      "env": {
        "dev": {
          "vars": {
            "R2_ATTACHMENTS_BUCKET": "cloud-agent-attachments-dev"
          }
        }
      }
    }`,
  });
  try {
    const plan = computeCloudAgentNextPlan(repo.root);
    assert.equal(plan.devVarsChanges.length, 1);
    const [change] = plan.devVarsChanges;
    assert.ok(change);
    assert.deepEqual(change.missingValues, []);
    assert.equal(
      change.keyChanges.find(keyChange => keyChange.key === 'R2_ATTACHMENTS_BUCKET')?.newValue,
      'local-attachments'
    );
  } finally {
    repo.cleanup();
  }
});
