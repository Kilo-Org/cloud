import { describe, expect, it } from 'vitest';
import {
  CLOUD_AGENT_FAILURE_CODES,
  CLOUD_AGENT_FAILURE_STAGES,
  CLOUD_AGENT_PROVIDER_OWNERSHIPS,
  CloudAgentCallbackFailureSchema,
  CloudAgentFailureReasonSchema,
  CloudAgentSafeFailureSchema,
  classifyCloudAgentFailure,
  isWorkspaceFailureSubtype,
  WORKSPACE_FAILURE_SUBTYPES,
} from './cloud-agent-failure.js';

describe('CloudAgentCallbackFailureSchema', () => {
  it('retains failures accepted by the strict producer contract', () => {
    const failure = {
      stage: 'pre_dispatch',
      code: 'workspace_setup_failed',
      subtype: 'git_clone_timeout',
      attempts: 2,
      message: 'Repository clone timed out',
    };

    expect(CloudAgentCallbackFailureSchema.parse(failure)).toEqual(failure);
  });

  it.each([
    { code: 'future_failure_code', message: 'Future failure' },
    { code: 'workspace_setup_failed', subtype: 'future_workspace_failure' },
    { code: 'assistant_error', futureField: true },
    { code: 'assistant_error', assistantReason: 'ContextOverflowError' },
    { code: 'assistant_error', assistantReason: null },
    { code: 'assistant_error', providerOwnership: 'future_ownership' },
    { attempts: -1 },
    { message: 'x'.repeat(4_097) },
  ])('discards unsupported or malformed structured failures: %o', failure => {
    expect(CloudAgentCallbackFailureSchema.parse(failure)).toBeUndefined();
  });
});

describe('classifyCloudAgentFailure', () => {
  it.each([
    ['payment_required', 'insufficient_credits'],
    ['model_missing', 'model_unavailable'],
  ] as const)('classifies explicit %s as user action', (code, reason) => {
    expect(classifyCloudAgentFailure({ source: 'run', stage: 'agent_activity', code })).toEqual({
      responsibility: 'user',
      reason,
    });
  });

  it('preserves ambiguous assistant failures as unknown', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'agent_activity',
        code: 'assistant_error',
        assistantReason: 'unknown',
        providerOwnership: 'unknown',
      })
    ).toEqual({ responsibility: 'unknown', reason: 'assistant_unknown' });
  });

  it('attributes source-control infrastructure failures to the platform', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'pre_dispatch',
        code: 'workspace_setup_failed',
        workspaceSubtype: 'git_network_failed',
      })
    ).toEqual({ responsibility: 'platform', reason: 'source_control_network' });
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'pre_dispatch',
        code: 'workspace_setup_failed',
        workspaceSubtype: 'git_pack_corrupt',
      })
    ).toEqual({ responsibility: 'platform', reason: 'source_control_repository_corrupt' });
  });

  it.each([
    ['provider_authentication', 'byok', 'user', 'provider_authentication'],
    ['provider_authentication', 'managed', 'platform', 'managed_provider_authentication'],
    ['provider_authentication', 'unknown', 'unknown', 'provider_ownership_unknown'],
    ['provider_authentication', undefined, 'unknown', 'provider_ownership_unknown'],
    ['provider_unavailable', 'byok', 'unknown', 'provider_unavailable'],
    ['provider_unavailable', 'managed', 'platform', 'managed_provider_unavailable'],
    ['provider_unavailable', 'unknown', 'unknown', 'provider_ownership_unknown'],
    ['provider_unavailable', undefined, 'unknown', 'provider_ownership_unknown'],
  ] as const)(
    'classifies %s with %s ownership without losing the known cause',
    (assistantReason, providerOwnership, responsibility, reason) => {
      expect(
        classifyCloudAgentFailure({
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          assistantReason,
          providerOwnership,
        })
      ).toEqual({ responsibility, reason });
    }
  );

  it.each([
    ['managed', 'platform', 'request_timeout'],
    ['byok', 'unknown', 'request_timeout'],
    ['unknown', 'unknown', 'provider_ownership_unknown'],
    [undefined, 'unknown', 'provider_ownership_unknown'],
  ] as const)(
    'retains request_timeout with %s ownership',
    (providerOwnership, responsibility, reason) => {
      const failure = classifyCloudAgentFailure({
        source: 'run',
        stage: 'agent_activity',
        code: 'assistant_error',
        assistantReason: 'timeout',
        providerOwnership,
      });

      expect(failure).toEqual({ responsibility, reason });
      expect(CloudAgentFailureReasonSchema.parse(failure.reason)).toBe(reason);
    }
  );

  it.each([
    ['invalid_request', 'assistant_invalid_request'],
    ['context_limit', 'assistant_context_limit'],
    ['output_limit', 'assistant_output_limit'],
  ] as const)(
    'attributes %s by provider ownership without collapsing the cause',
    (assistantReason, expectedReason) => {
      const cases = [
        ['byok', 'user'],
        ['managed', 'platform'],
        ['unknown', 'unknown'],
        [undefined, 'unknown'],
      ] as const;

      for (const [providerOwnership, responsibility] of cases) {
        const failure = classifyCloudAgentFailure({
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          assistantReason,
          providerOwnership,
        });

        expect(failure).toEqual({ responsibility, reason: expectedReason });
        expect(CloudAgentFailureReasonSchema.parse(failure.reason)).toBe(expectedReason);
      }
    }
  );

  it('attributes content filter to the user and structured output to the platform', () => {
    for (const providerOwnership of [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined]) {
      expect(
        classifyCloudAgentFailure({
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          assistantReason: 'content_filter',
          providerOwnership,
        })
      ).toEqual({ responsibility: 'user', reason: 'assistant_content_filter' });
      expect(
        classifyCloudAgentFailure({
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          assistantReason: 'structured_output',
          providerOwnership,
        })
      ).toEqual({ responsibility: 'platform', reason: 'assistant_structured_output' });
    }
  });

  it.each(['insufficient_credits', 'rate_limited'] as const)(
    'keeps %s as user responsibility regardless of provider ownership',
    assistantReason => {
      for (const providerOwnership of [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined]) {
        expect(
          classifyCloudAgentFailure({
            source: 'run',
            stage: 'agent_activity',
            code: 'assistant_error',
            assistantReason,
            providerOwnership,
          })
        ).toEqual({ responsibility: 'user', reason: assistantReason });
      }
    }
  );

  it.each([true, false, undefined])(
    'uses managed model selection %s rather than provider ownership for model failures',
    managedModelSelection => {
      for (const providerOwnership of [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined]) {
        for (const code of ['assistant_error', 'model_missing'] as const) {
          expect(
            classifyCloudAgentFailure({
              source: 'run',
              stage: 'agent_activity',
              code,
              assistantReason: 'model_unavailable',
              providerOwnership,
              managedModelSelection,
            })
          ).toEqual(
            managedModelSelection
              ? { responsibility: 'platform', reason: 'managed_model_configuration' }
              : { responsibility: 'user', reason: 'model_unavailable' }
          );
        }
      }
    }
  );

  it.each([
    ['git_clone_timeout', 'platform', 'source_control_clone_timeout'],
    ['git_checkout_timeout', 'platform', 'source_control_checkout_timeout'],
    ['git_pack_corrupt', 'platform', 'source_control_repository_corrupt'],
    ['setup_command_timeout', 'user', 'setup_command_timeout'],
    ['setup_command_failed', 'user', 'setup_command'],
    ['kilo_import_timeout', 'platform', 'session_import_timeout'],
    ['kilo_import_failed', 'platform', 'session_import_failed'],
  ] as const)(
    'splits collapsed workspace subtype %s into reason %s',
    (workspaceSubtype, responsibility, reason) => {
      expect(
        classifyCloudAgentFailure({
          source: 'run',
          stage: 'pre_dispatch',
          code: 'workspace_setup_failed',
          workspaceSubtype,
        })
      ).toEqual({ responsibility, reason });
    }
  );

  it.each([
    ['wrapper_disconnected', 'wrapper_disconnected'],
    ['wrapper_no_output', 'wrapper_liveness'],
    ['wrapper_ping_timeout', 'wrapper_liveness'],
    ['wrapper_error_before_activity', 'wrapper_startup'],
    ['wrapper_error_after_activity', 'wrapper_crash'],
    ['missing_assistant_reply', 'assistant_no_reply'],
  ] as const)('splits wrapper code %s into platform reason %s', (code, reason) => {
    expect(classifyCloudAgentFailure({ source: 'run', stage: 'agent_activity', code })).toEqual({
      responsibility: 'platform',
      reason,
    });
  });

  it.each([
    ['user_interrupt', 'user', 'user_interrupt'],
    ['container_shutdown', 'platform', 'container_shutdown'],
    ['system_interrupt', 'platform', 'system_interrupt'],
  ] as const)('attributes interruption code %s to %s/%s', (code, responsibility, reason) => {
    expect(classifyCloudAgentFailure({ source: 'run', stage: 'interruption', code })).toEqual({
      responsibility,
      reason,
    });
  });

  it('classifies setup failures from structured stage and code only', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'initial_admission',
        code: 'invalid_initial_intent',
      })
    ).toEqual({ responsibility: 'user', reason: 'initial_request_invalid' });
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'transport',
        code: 'do_rpc_outcome_unknown',
      })
    ).toEqual({ responsibility: 'platform', reason: 'session_coordination' });
  });

  it('attributes the opaque initial admission rejection from its admission code', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'initial_admission',
        code: 'initial_admission_rejected',
        admissionCode: 'INTERNAL',
      })
    ).toEqual({ responsibility: 'platform', reason: 'admission_internal' });
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'initial_admission',
        code: 'initial_admission_rejected',
        admissionCode: 'SANDBOX_CONNECT_FAILED',
      })
    ).toEqual({ responsibility: 'platform', reason: 'sandbox_connectivity' });
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'initial_admission',
        code: 'initial_admission_rejected',
        admissionCode: 'PAYMENT_REQUIRED',
      })
    ).toEqual({ responsibility: 'user', reason: 'insufficient_credits' });
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'initial_admission',
        code: 'initial_admission_rejected',
        admissionCode: 'UNKNOWN',
      })
    ).toEqual({ responsibility: 'unknown', reason: 'initial_admission_unknown' });
  });

  it('classifies a full admission queue as platform capacity, not unknown', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'initial_admission',
        code: 'initial_queue_full',
        admissionCode: 'PENDING_QUEUE_FULL',
      })
    ).toEqual({ responsibility: 'platform', reason: 'admission_capacity' });
  });
});

describe('CloudAgentSafeFailureSchema', () => {
  it('accepts every shared contract value', () => {
    for (const stage of CLOUD_AGENT_FAILURE_STAGES) {
      expect(CloudAgentSafeFailureSchema.safeParse({ stage }).success).toBe(true);
    }
    for (const code of CLOUD_AGENT_FAILURE_CODES) {
      expect(CloudAgentSafeFailureSchema.safeParse({ code }).success).toBe(true);
    }
    for (const subtype of WORKSPACE_FAILURE_SUBTYPES) {
      expect(
        CloudAgentSafeFailureSchema.safeParse({ code: 'workspace_setup_failed', subtype }).success
      ).toBe(true);
      expect(isWorkspaceFailureSubtype(subtype)).toBe(true);
    }
  });

  it('requires workspace_setup_failed when subtype is present', () => {
    expect(CloudAgentSafeFailureSchema.safeParse({ subtype: 'git_clone_timeout' }).success).toBe(
      false
    );
    expect(
      CloudAgentSafeFailureSchema.safeParse({
        code: 'assistant_error',
        subtype: 'git_clone_timeout',
      }).success
    ).toBe(false);
  });

  it('enforces strict optional field bounds', () => {
    expect(CloudAgentSafeFailureSchema.safeParse({}).success).toBe(true);
    expect(CloudAgentSafeFailureSchema.safeParse({ attempts: 0, message: 'x' }).success).toBe(true);
    expect(CloudAgentSafeFailureSchema.safeParse({ attempts: -1 }).success).toBe(false);
    expect(CloudAgentSafeFailureSchema.safeParse({ attempts: 1.5 }).success).toBe(false);
    expect(CloudAgentSafeFailureSchema.safeParse({ message: '' }).success).toBe(false);
    expect(CloudAgentSafeFailureSchema.safeParse({ message: 'x'.repeat(4_097) }).success).toBe(
      false
    );
    expect(CloudAgentSafeFailureSchema.safeParse({ extra: true }).success).toBe(false);
    expect(isWorkspaceFailureSubtype('not_allowlisted')).toBe(false);
  });
});
