import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertBootstrapOwnership, hasSavedState, releaseCleanupGate } from './cleanup.js';
import { describeMessageFailure, LocalApiError, messageSchema } from './context.js';

const tag = 'maintenance-synthetic-busy';

await test('cleanup tolerates only the exact owned missing-waiter response', async () => {
  const passed: string[] = [];
  await releaseCleanupGate(
    {
      request: async () => {
        throw new LocalApiError('/test/release', 404, `no waiter for tag: ${tag}`);
      },
      pass: name => {
        passed.push(name);
      },
    },
    tag
  );
  assert.equal(passed.length, 1);
});

for (const [label, error] of [
  ['another tag', new LocalApiError('/test/release', 404, 'no waiter for tag: other')],
  ['unknown route', new LocalApiError('/test/release', 404, 'not found: POST /test/release')],
  ['missing response body', new LocalApiError('/test/release', 404)],
  ['other endpoint', new LocalApiError('/test/waiters', 404, `no waiter for tag: ${tag}`)],
  ['authentication', new LocalApiError('/test/release', 401, 'Unauthorized')],
  ['server failure', new LocalApiError('/test/release', 500, `no waiter for tag: ${tag}`)],
  ['network failure', new TypeError('fetch failed')],
] as const) {
  await test(`cleanup preserves ${label} failures`, async () => {
    await assert.rejects(
      releaseCleanupGate(
        {
          request: async () => {
            throw error;
          },
          pass: () => assert.fail('Genuine failures cannot be recorded as successful cleanup'),
        },
        tag
      ),
      actual => actual === error
    );
  });
}

const bootstrap = {
  runId: '00000000-0000-4000-8000-000000000001',
  tag: 'maintenance-synthetic',
  userId: 'oauth/synthetic-local-owner',
  profileId: '00000000-0000-4000-8000-000000000002',
  bootstrapOperationKey: '00000000-0000-4000-8000-000000000003',
};
const user = {
  id: bootstrap.userId,
  email: `${bootstrap.tag}@cloud-agent-next-e2e.example.com`,
  api_token_pepper: null,
};
const profile = {
  owned_by_user_id: bootstrap.userId,
  description: `Synthetic maintenance acceptance ${bootstrap.runId}`,
};

await test('partial preparation needs no watch/integration/full state to prove profile ownership', () => {
  assert.doesNotThrow(() => assertBootstrapOwnership(bootstrap, user, profile));
  assert.doesNotThrow(() => assertBootstrapOwnership(bootstrap, user, undefined));
  assert.throws(() => assertBootstrapOwnership(bootstrap, { ...user, id: 'other-owner' }, profile));
  assert.throws(() =>
    assertBootstrapOwnership(bootstrap, { ...user, email: 'other@example.com' }, profile)
  );
  assert.throws(() =>
    assertBootstrapOwnership(bootstrap, user, { ...profile, owned_by_user_id: 'other-owner' })
  );
  assert.throws(() =>
    assertBootstrapOwnership(bootstrap, user, { ...profile, description: 'not this run' })
  );
});

await test('only a missing state file selects bootstrap cleanup; unsafe files still fail', async () => {
  const out = await mkdtemp('/tmp/kilo2/pr-maintenance-cleanup-test-');
  try {
    assert.equal(await hasSavedState({ out }), false);
    await writeFile(path.join(out, 'state.json'), '{}', { mode: 0o600 });
    assert.equal(await hasSavedState({ out }), true);
    await rm(path.join(out, 'state.json'));
    await writeFile(path.join(out, 'state.json'), '{}', { mode: 0o644 });
    await assert.rejects(hasSavedState({ out }), /mode 600/);
  } finally {
    await rm(out, { recursive: true });
  }
});

await test('terminal diagnostics retain safe codes/details and explicitly identify missing evidence', () => {
  const base = {
    cloudAgentSessionId: 'workspace_synthetic',
    messageId: 'msg_synthetic',
    status: 'failed',
  };
  const rich = messageSchema.parse({
    ...base,
    failureCode: 'workspace_setup_failed',
    failure: {
      stage: 'prepare',
      code: 'workspace_setup_failed',
      subtype: 'synthetic_configuration',
      message: 'Synthetic setup was rejected.',
    },
  });
  assert.equal(
    describeMessageFailure(rich),
    'failed: workspace_setup_failed; prepare; synthetic_configuration; Synthetic setup was rejected.'
  );
  assert.equal(
    describeMessageFailure(messageSchema.parse(base)),
    'failed: runtime supplied no safe failure reason'
  );
});
