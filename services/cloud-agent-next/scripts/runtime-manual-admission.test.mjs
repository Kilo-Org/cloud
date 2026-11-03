import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitManualRuntimePublication,
  readManualAdmissionMetadata,
} from './runtime-manual-admission.mjs';

function fixture() {
  const repository = { id: 42, full_name: 'Kilo-Org/cloud' };
  const workflow = { id: 8, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };
  const run = {
    id: 9,
    workflow_id: 8,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    repository,
    head_repository: repository,
  };
  return {
    repository,
    workflow,
    run,
    sourceSha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    runs: [run],
  };
}

function admit(f) {
  return admitManualRuntimePublication({
    sourceSha: f.sourceSha,
    ref: f.ref,
    runs: f.runs,
    workflow: f.workflow,
    repository: f.repository,
  });
}

test('admits a manual main SHA with a successful trusted CI run', () => {
  const f = fixture();
  assert.equal(admit(f), 'a'.repeat(40));
});

for (const [name, mutate] of [
  [
    'a non-main ref',
    f => {
      f.ref = 'refs/heads/feature';
    },
  ],
  [
    'a tag ref',
    f => {
      f.ref = 'refs/tags/v1';
    },
  ],
  [
    'a malformed SHA',
    f => {
      f.sourceSha = 'main';
    },
  ],
  [
    'a different SHA',
    f => {
      f.sourceSha = 'b'.repeat(40);
    },
  ],
  [
    'a failed run',
    f => {
      f.run.conclusion = 'failure';
    },
  ],
  [
    'an incomplete run',
    f => {
      f.run.status = 'in_progress';
    },
  ],
  [
    'a pull request run',
    f => {
      f.run.event = 'pull_request';
    },
  ],
  [
    'a non-main branch',
    f => {
      f.run.head_branch = 'feature';
    },
  ],
  [
    'a fork',
    f => {
      f.run.head_repository = { id: 99 };
    },
  ],
  [
    'a different workflow path',
    f => {
      f.run.path = '.github/workflows/other.yml';
    },
  ],
  [
    'an inactive workflow',
    f => {
      f.workflow.state = 'disabled_manually';
    },
  ],
  [
    'a different repository name',
    f => {
      f.repository.full_name = 'fork/cloud';
    },
  ],
  [
    'a missing run',
    f => {
      f.runs = [];
    },
  ],
])
  test('rejects ' + name, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => admit(f));
  });

test('reads the CI workflow, repository, successful main CI runs and each run', async () => {
  const urls = [];
  const metadata = await readManualAdmissionMetadata('a'.repeat(40), 'token', async url => {
    urls.push(url);
    if (url.includes('/runs?head_sha=')) {
      return new Response(JSON.stringify({ workflow_runs: [{ id: 9 }] }));
    }
    return new Response(JSON.stringify({ id: 9, url }));
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/Kilo-Org/cloud/actions/workflows/ci.yml',
    'https://api.github.com/repos/Kilo-Org/cloud',
    'https://api.github.com/repos/Kilo-Org/cloud/actions/workflows/ci.yml/runs?head_sha=' +
      'a'.repeat(40) +
      '&event=push&status=success&per_page=10',
    'https://api.github.com/repos/Kilo-Org/cloud/actions/runs/9',
  ]);
  assert.equal(metadata.runs.length, 1);
});

test('rejects a malformed manual SHA before any request', async () => {
  await assert.rejects(
    readManualAdmissionMetadata('main', 'token', async () => {
      throw new Error('unexpected request');
    })
  );
});
