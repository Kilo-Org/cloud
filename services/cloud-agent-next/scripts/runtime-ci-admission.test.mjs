import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitRuntimePublication, readAdmissionMetadata } from './runtime-ci-admission.mjs';

function fixture() {
  const repository = { id: 42, full_name: 'Kilo-Org/cloud' };
  const workflow = { id: 8, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };
  const run = {
    id: 9,
    workflow_id: 8,
    name: 'CI',
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    repository,
    head_repository: repository,
  };
  return { repository, workflow, run, event: { repository, workflow_run: structuredClone(run) } };
}
test('reads admission metadata from the exact GitHub API resources', async () => {
  const urls = [];
  const metadata = await readAdmissionMetadata(9, 'token', async url => {
    urls.push(url);
    return new Response(JSON.stringify({ url }));
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/Kilo-Org/cloud/actions/runs/9',
    'https://api.github.com/repos/Kilo-Org/cloud/actions/workflows/ci.yml',
    'https://api.github.com/repos/Kilo-Org/cloud',
  ]);
  assert.deepEqual(
    metadata.map(item => item.url),
    urls
  );
});
test('admits only the exact successful main CI SHA', () => {
  const f = fixture();
  assert.equal(admitRuntimePublication(f.event, f.run, f.workflow, f.repository), 'a'.repeat(40));
});
for (const [name, mutate] of [
  [
    'pull request',
    f => {
      f.run.event = 'pull_request';
      f.event.workflow_run.event = 'pull_request';
    },
  ],
  [
    'merge queue',
    f => {
      f.run.event = 'merge_group';
      f.event.workflow_run.event = 'merge_group';
    },
  ],
  [
    'failed CI',
    f => {
      f.run.conclusion = 'failure';
    },
  ],
  [
    'cancelled CI',
    f => {
      f.event.workflow_run.conclusion = 'cancelled';
    },
  ],
  [
    'different branch',
    f => {
      f.run.head_branch = 'feature';
    },
  ],
  [
    'fork',
    f => {
      f.run.head_repository = { id: 99 };
    },
  ],
  [
    'forged repository name',
    f => {
      f.event.repository = { ...f.repository, full_name: 'fork/cloud' };
    },
  ],
  [
    'repository ID mismatch',
    f => {
      f.event.repository = { ...f.repository, id: 99 };
    },
  ],
  [
    'different workflow path',
    f => {
      f.workflow.path = '.github/workflows/other.yml';
    },
  ],
  [
    'different workflow ID',
    f => {
      f.run.workflow_id = 7;
    },
  ],
  [
    'different run',
    f => {
      f.event.workflow_run.id = 10;
    },
  ],
  [
    'different SHA',
    f => {
      f.event.workflow_run.head_sha = 'b'.repeat(40);
    },
  ],
  [
    'malformed SHA',
    f => {
      f.run.head_sha = 'main';
      f.event.workflow_run.head_sha = 'main';
    },
  ],
  [
    'incomplete run',
    f => {
      f.run.status = 'in_progress';
    },
  ],
])
  test('rejects ' + name, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => admitRuntimePublication(f.event, f.run, f.workflow, f.repository));
  });
