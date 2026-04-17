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
