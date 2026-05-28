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

test('overrides the pulled web attachment bucket for nextjs development-local output', () => {
  const repo = createRepo({
    '.env.local': 'CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME=cloud-agent-attachments\n',
    'apps/web/.env.development.local.example': fs.readFileSync(
      new URL('../../../apps/web/.env.development.local.example', import.meta.url),
      'utf-8'
    ),
  });
  try {
    const plan = computePlan(repo.root, new Set(['nextjs']));
    assert.equal(plan.missingEnvLocal, false);
    assert.deepEqual(
      plan.envDevLocalChanges.find(
        change => change.key === 'CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME'
      ),
      {
        key: 'CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME',
        oldValue: undefined,
        newValue: 'cloud-agent-attachments-dev',
      }
    );
  } finally {
    repo.cleanup();
  }
});

test('reconciles an incorrect generated web override to its template literal', () => {
  const repo = createRepo({
    '.env.local': 'ATTACHMENTS_BUCKET=production-bucket\n',
    'apps/web/.env.development.local.example':
      '# @override\nATTACHMENTS_BUCKET=development-bucket\n',
    'apps/web/.env.development.local': 'ATTACHMENTS_BUCKET=stale-bucket\n',
  });
  try {
    const plan = computePlan(repo.root, new Set(['nextjs']));
    assert.deepEqual(plan.envDevLocalChanges, [
      {
        key: 'ATTACHMENTS_BUCKET',
        oldValue: 'stale-bucket',
        newValue: 'development-bucket',
      },
    ]);
  } finally {
    repo.cleanup();
  }
});

test('leaves an already correct generated web override unchanged', () => {
  const repo = createRepo({
    '.env.local': 'ATTACHMENTS_BUCKET=production-bucket\n',
    'apps/web/.env.development.local.example':
      '# @override\nATTACHMENTS_BUCKET=development-bucket\n',
    'apps/web/.env.development.local': 'ATTACHMENTS_BUCKET=development-bucket\n',
  });
  try {
    const plan = computePlan(repo.root, new Set(['nextjs']));
    assert.deepEqual(plan.envDevLocalChanges, []);
  } finally {
    repo.cleanup();
  }
});

test('preserves root-first resolution for unannotated web template entries', () => {
  const repo = createRepo({
    '.env.local': 'STRIPE_PRICE_ID=pulled-stripe-price\n',
    'apps/web/.env.development.local.example': 'STRIPE_PRICE_ID=template-stripe-price\n',
  });
  try {
    const plan = computePlan(repo.root, new Set(['nextjs']));
    assert.deepEqual(plan.envDevLocalChanges, [
      {
        key: 'STRIPE_PRICE_ID',
        oldValue: undefined,
        newValue: 'pulled-stripe-price',
      },
    ]);
  } finally {
    repo.cleanup();
  }
});

test('applies an explicit worker override even when root and existing dev vars differ', () => {
  const repo = createRepo({
    '.env.local': 'SHARED_BUCKET=production-bucket\n',
    [`${workerDir}/.dev.vars.example`]: '# @override\nSHARED_BUCKET=development-bucket\n',
    [`${workerDir}/.dev.vars`]: 'SHARED_BUCKET=stale-bucket\n',
  });
  try {
    const plan = computePlan(repo.root, new Set(['cloud-agent-next']));
    assert.deepEqual(plan.devVarsChanges, [
      {
        workerDir,
        isNew: false,
        keyChanges: [
          {
            key: 'SHARED_BUCKET',
            oldValue: 'stale-bucket',
            newValue: 'development-bucket',
          },
        ],
        missingValues: [],
        newFileContent: undefined,
      },
    ]);
  } finally {
    repo.cleanup();
  }
});

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

test('preserves host.docker.internal in @url defaults for useLanIp services', () => {
  const repo = createRepo({
    '.env.local': '',
    [`${workerDir}/package.json`]: JSON.stringify(
      { scripts: { dev: "wrangler dev --env 'dev'" } },
      null,
      2
    ),
    [`${workerDir}/wrangler.jsonc`]: '{ "dev": { "port": 8794 } }',
    [`${workerDir}/.dev.vars.example`]: [
      '# @url nextjs',
      'KILOCODE_BACKEND_BASE_URL=http://host.docker.internal:3000',
      '# @url cloud-agent-next',
      'WORKER_URL=http://host.docker.internal:8794',
      '# @url nextjs',
      'ALLOWED_ORIGINS=http://localhost:3000',
      '',
    ].join('\n'),
  });
  try {
    const plan = computePlan(repo.root, new Set(['cloud-agent-next']));
    assert.equal(plan.missingEnvLocal, false);
    assert.equal(plan.devVarsChanges.length, 1);
    const [change] = plan.devVarsChanges;
    assert.ok(change);
    assert.equal(change.isNew, true);
    const content = change.newFileContent ?? '';
    assert.ok(content.includes('KILOCODE_BACKEND_BASE_URL=http://host.docker.internal:3000'));
    assert.ok(content.includes('WORKER_URL=http://host.docker.internal:8794'));
    // ORIGINS keys still use localhost even when example default has host.docker.internal
    assert.ok(content.includes('ALLOWED_ORIGINS=http://localhost:3000'));
  } finally {
    repo.cleanup();
  }
});

test('preserves localhost in worker-side @url defaults for useLanIp services', () => {
  const repo = createRepo({
    '.env.local': '',
    [`${workerDir}/package.json`]: JSON.stringify(
      { scripts: { dev: "wrangler dev --env 'dev'" } },
      null,
      2
    ),
    [`${workerDir}/wrangler.jsonc`]: '{ "dev": { "port": 8794 } }',
    [`${workerDir}/.dev.vars.example`]: [
      '# @url nextjs',
      'KILOCODE_BACKEND_BASE_URL=http://localhost:3000',
      '# @url nextjs/api',
      'KILO_OPENROUTER_BASE=http://localhost:3000/api',
      '# @url cloud-agent-next',
      'WORKER_URL=http://host.docker.internal:8794',
      '',
    ].join('\n'),
  });
  try {
    const plan = computePlan(repo.root, new Set(['cloud-agent-next']));
    assert.equal(plan.missingEnvLocal, false);
    assert.equal(plan.devVarsChanges.length, 1);
    const [change] = plan.devVarsChanges;
    assert.ok(change);
    assert.equal(change.isNew, true);
    const content = change.newFileContent ?? '';
    assert.ok(content.includes('KILOCODE_BACKEND_BASE_URL=http://localhost:3000'));
    assert.ok(content.includes('KILO_OPENROUTER_BASE=http://localhost:3000/api'));
    assert.ok(content.includes('WORKER_URL=http://host.docker.internal:8794'));
  } finally {
    repo.cleanup();
  }
});
