import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { watchPrMaintenanceResultSchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { createFakeLlmState, handleFakeLlmRequest, type FakeLlmEmit } from '../fake-llm-core.js';
import { LocalApiError, maintenanceStatusSchema, stateSchema } from './contracts.js';
import { maintenanceFixturePrompt, noPublicationResult } from './review-fixtures.js';
import { assertNoInitialAdmission, isPreRegistrationStopConflict } from './review-scenarios.js';

await test('realistic fake emits exactly the structured no-publication result despite appended runtime instructions', async () => {
  const tag = 'maintenance-synthetic-result';
  const prompt = maintenanceFixturePrompt(tag, {
    kind: 'result-continuation',
    gate: `${tag}-attempt`,
  });
  let content = '';
  let started = false;
  let ended = false;
  let close: (() => void) | undefined;
  const emit: FakeLlmEmit = {
    start: () => {
      started = true;
    },
    sse: value => {
      const chunk = z
        .object({
          choices: z.array(z.object({ delta: z.object({ content: z.string().optional() }) })),
        })
        .parse(value);
      content += chunk.choices.map(choice => choice.delta.content ?? '').join('');
    },
    done: () => {
      ended = true;
    },
    end: () => {
      ended = true;
    },
    isStarted: () => started,
    onClose: listener => {
      close = listener;
    },
    json: (status, body) =>
      assert.fail(`Unexpected fake JSON error ${status}: ${JSON.stringify(body)}`),
    empty: status => assert.fail(`Unexpected empty fake response ${status}`),
    fail: error => {
      throw error;
    },
  };
  await handleFakeLlmRequest(
    {
      method: 'POST',
      url: '/api/openrouter/chat/completions',
      headers: {},
      readText: async () =>
        JSON.stringify({
          model: 'kilo/fake-deterministic',
          messages: [
            {
              role: 'user',
              content: `${prompt}\n\nRuntime maintenance instructions:\nDo not publish.`,
            },
          ],
        }),
    },
    emit,
    createFakeLlmState(),
    { adminToken: undefined }
  );
  close?.();
  assert(ended);
  assert.deepEqual(
    watchPrMaintenanceResultSchema.parse(JSON.parse(content)),
    noPublicationResult(tag)
  );
});

await test('pre-registration Stop accepts only the exact stable 409 conflict', () => {
  assert(
    isPreRegistrationStopConflict(
      new LocalApiError('/internal/pr-maintenance/start', 409, 'maintenance_attempt_stopped')
    )
  );
  for (const error of [
    new LocalApiError('/internal/pr-maintenance/start', 503, 'maintenance_runtime_unavailable'),
    new LocalApiError(
      '/internal/pr-maintenance/start',
      409,
      'maintenance_workspace_identity_changed'
    ),
    new LocalApiError('/internal/pr-maintenance/start', 403, 'maintenance_attempt_stopped'),
    new LocalApiError('/internal/pr-maintenance/stop', 409, 'maintenance_attempt_stopped'),
    new TypeError('fetch failed'),
  ])
    assert.equal(isPreRegistrationStopConflict(error), false);
});

await test('pre-registration Stop assertions reject accepted, running, completed, or unfenced initial work', () => {
  const base = {
    message: null,
    latestMessage: null,
    stoppedAt: 123,
    waitingForInput: false,
    result: null,
    publication: null,
    resultMessageId: null,
    publicationMessageId: null,
  };
  assert.doesNotThrow(() => assertNoInitialAdmission(maintenanceStatusSchema.parse(base)));
  assert.throws(() =>
    assertNoInitialAdmission(maintenanceStatusSchema.parse({ ...base, stoppedAt: null }))
  );
  for (const status of ['queued', 'running', 'completed']) {
    assert.throws(() =>
      assertNoInitialAdmission(
        maintenanceStatusSchema.parse({
          ...base,
          message: {
            cloudAgentSessionId: 'workspace_synthetic',
            messageId: 'msg_synthetic',
            status,
          },
        })
      )
    );
  }
  assert.throws(() =>
    assertNoInitialAdmission(
      maintenanceStatusSchema.parse({
        ...base,
        message: {
          cloudAgentSessionId: 'workspace_synthetic',
          messageId: 'msg_synthetic',
          status: 'interrupted',
          acceptedAt: 100,
        },
      })
    )
  );
});

await test('private state retains review scenario and continuation identities without replacement IDs', () => {
  const state = stateSchema.parse({
    version: 1,
    runId: '00000000-0000-4000-8000-000000000001',
    tag: 'maintenance-synthetic',
    userId: 'oauth/synthetic-local-owner',
    profileId: '00000000-0000-4000-8000-000000000002',
    workspaceId: 'worktree_00000000-0000-4000-8000-000000000003',
    root: {
      kiloSessionId: 'ses_synthetic',
      cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000004',
      messageId: 'msg_bootstrap',
    },
    integrationId: '00000000-0000-4000-8000-000000000005',
    watchId: '00000000-0000-4000-8000-000000000006',
    bootstrapOperationKey: '00000000-0000-4000-8000-000000000007',
    attempts: [
      {
        kind: 'result-continuation',
        gate: 'synthetic-result-attempt',
        id: '00000000-0000-4000-8000-000000000008',
        creationOperationKey: '00000000-0000-4000-8000-000000000009',
        kiloSessionId: 'ses_maintenance',
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000010',
        messageId: 'msg_initial',
        continuationMessageId: 'msg_followup',
      },
    ],
  });
  assert.equal(state.attempts[0]?.continuationMessageId, 'msg_followup');
  assert.equal(state.attempts[0]?.messageId, 'msg_initial');
  const stopPrompt = maintenanceFixturePrompt(state.tag, {
    kind: 'stop-before-start',
    gate: 'synthetic-stop-attempt',
  });
  assert(
    stopPrompt.startsWith(
      '__e2e_scope__:synthetic-stop-attempt\n__fake__:gate:synthetic-stop-attempt'
    )
  );
});
