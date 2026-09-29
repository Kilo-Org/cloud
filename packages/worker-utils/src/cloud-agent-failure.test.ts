import { describe, expect, it } from 'vitest';
import {
  CLOUD_AGENT_ADMISSION_FAILURE_CODES,
  CLOUD_AGENT_ASSISTANT_FAILURE_REASONS,
  CLOUD_AGENT_FAILURE_CODES,
  CLOUD_AGENT_FAILURE_RESPONSIBILITIES,
  CLOUD_AGENT_FAILURE_STAGES,
  CLOUD_AGENT_PROVIDER_OWNERSHIPS,
  CloudAgentCallbackFailureSchema,
  CloudAgentFailureReasonSchema,
  CloudAgentFailureResponsibilitySchema,
  CloudAgentSafeFailureSchema,
  classifyCloudAgentFailure,
  isWorkspaceFailureSubtype,
  WORKSPACE_FAILURE_SUBTYPES,
  type CloudAgentAdmissionFailureCode,
  type CloudAgentAssistantFailureReason,
  type CloudAgentFailureClassification,
  type CloudAgentFailureCode,
  type CloudAgentProviderOwnership,
  type WorkspaceFailureSubtype,
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
  it('classifies explicit payment_required as a user action', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'agent_activity',
        code: 'payment_required',
      })
    ).toEqual({ responsibility: 'user', reason: 'insufficient_credits' });
  });

  it('classifies an explicit model_missing as an unavailable model', () => {
    expect(
      classifyCloudAgentFailure({ source: 'run', stage: 'agent_activity', code: 'model_missing' })
    ).toEqual({ responsibility: 'provider', reason: 'model_unavailable' });
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
    ['provider_unavailable', 'byok', 'provider', 'provider_unavailable'],
    ['provider_unavailable', 'managed', 'provider', 'managed_provider_unavailable'],
    ['provider_unavailable', 'unknown', 'provider', 'provider_ownership_unknown'],
    ['provider_unavailable', undefined, 'provider', 'provider_ownership_unknown'],
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
    ['managed', 'provider', 'request_timeout'],
    ['byok', 'provider', 'request_timeout'],
    ['unknown', 'provider', 'provider_ownership_unknown'],
    [undefined, 'provider', 'provider_ownership_unknown'],
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

  it('attributes invalid_request by provider ownership without collapsing the cause', () => {
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
        assistantReason: 'invalid_request',
        providerOwnership,
      });

      expect(failure).toEqual({ responsibility, reason: 'assistant_invalid_request' });
      expect(CloudAgentFailureReasonSchema.parse(failure.reason)).toBe('assistant_invalid_request');
    }
  });

  it.each([
    ['context_limit', 'assistant_context_limit'],
    ['output_limit', 'assistant_output_limit'],
  ] as const)(
    'attributes %s to the provider regardless of provider ownership',
    (assistantReason, expectedReason) => {
      for (const providerOwnership of [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined]) {
        const failure = classifyCloudAgentFailure({
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          assistantReason,
          providerOwnership,
        });

        expect(failure).toEqual({ responsibility: 'provider', reason: expectedReason });
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

  it('keeps insufficient_credits as user responsibility regardless of provider ownership', () => {
    for (const providerOwnership of [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined]) {
      expect(
        classifyCloudAgentFailure({
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          assistantReason: 'insufficient_credits',
          providerOwnership,
        })
      ).toEqual({ responsibility: 'user', reason: 'insufficient_credits' });
    }
  });

  it('attributes rate_limited to the provider regardless of provider ownership', () => {
    for (const providerOwnership of [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined]) {
      expect(
        classifyCloudAgentFailure({
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          assistantReason: 'rate_limited',
          providerOwnership,
        })
      ).toEqual({ responsibility: 'provider', reason: 'rate_limited' });
    }
  });

  it.each(['assistant_error', 'model_missing'] as const)(
    'attributes an unavailable model on %s to the provider regardless of ownership',
    code => {
      for (const providerOwnership of [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined]) {
        expect(
          classifyCloudAgentFailure({
            source: 'run',
            stage: 'agent_activity',
            code,
            assistantReason: 'model_unavailable',
            providerOwnership,
          })
        ).toEqual({ responsibility: 'provider', reason: 'model_unavailable' });
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

const ASSISTANT_FAILURE_CODES = ['assistant_error', 'payment_required', 'model_missing'] as const;

/**
 * Golden table: the exact classification the classifier emits for every
 * non-assistant run failure code. These are unchanged by the `provider`
 * responsibility; a deliberate classifier change updates this table.
 */
const NON_ASSISTANT_FAILURE_CLASSIFICATIONS = {
  sandbox_connect_failed: { responsibility: 'platform', reason: 'sandbox_connectivity' },
  workspace_setup_failed: { responsibility: 'unknown', reason: 'workspace_unknown' },
  kilo_server_failed: { responsibility: 'platform', reason: 'runtime_startup' },
  wrapper_start_failed: { responsibility: 'platform', reason: 'runtime_startup' },
  invalid_delivery_request: { responsibility: 'platform', reason: 'delivery' },
  session_metadata_missing: { responsibility: 'platform', reason: 'delivery' },
  delivery_failure_unknown: { responsibility: 'platform', reason: 'delivery' },
  wrapper_disconnected: { responsibility: 'platform', reason: 'wrapper_disconnected' },
  wrapper_no_output: { responsibility: 'platform', reason: 'wrapper_liveness' },
  wrapper_ping_timeout: { responsibility: 'platform', reason: 'wrapper_liveness' },
  wrapper_error_before_activity: { responsibility: 'platform', reason: 'wrapper_startup' },
  wrapper_error_after_activity: { responsibility: 'platform', reason: 'wrapper_crash' },
  missing_assistant_reply: { responsibility: 'platform', reason: 'assistant_no_reply' },
  user_interrupt: { responsibility: 'user', reason: 'user_interrupt' },
  container_shutdown: { responsibility: 'platform', reason: 'container_shutdown' },
  system_interrupt: { responsibility: 'platform', reason: 'system_interrupt' },
  unclassified: { responsibility: 'unknown', reason: 'unclassified' },
} as const satisfies Record<string, CloudAgentFailureClassification>;

const OWNERSHIP_MATRIX_INPUTS = {
  assistantReasons: [...CLOUD_AGENT_ASSISTANT_FAILURE_REASONS, undefined],
  providerOwnerships: [...CLOUD_AGENT_PROVIDER_OWNERSHIPS, undefined],
} as const;

/** Fixed expected classifications for every declared workspace failure subtype. */
const WORKSPACE_FAILURE_CLASSIFICATIONS = {
  git_clone_timeout: { responsibility: 'platform', reason: 'source_control_clone_timeout' },
  git_checkout_timeout: { responsibility: 'platform', reason: 'source_control_checkout_timeout' },
  git_authentication_failed: { responsibility: 'user', reason: 'source_control_authentication' },
  git_rate_limited: { responsibility: 'platform', reason: 'rate_limited' },
  git_network_failed: { responsibility: 'platform', reason: 'source_control_network' },
  git_pack_corrupt: { responsibility: 'platform', reason: 'source_control_repository_corrupt' },
  git_checkout_conflict: { responsibility: 'user', reason: 'source_control_configuration' },
  git_branch_missing: { responsibility: 'user', reason: 'source_control_configuration' },
  sandbox_storage_full: { responsibility: 'platform', reason: 'sandbox_capacity' },
  kilo_import_timeout: { responsibility: 'platform', reason: 'session_import_timeout' },
  kilo_import_failed: { responsibility: 'platform', reason: 'session_import_failed' },
  setup_command_timeout: { responsibility: 'user', reason: 'setup_command_timeout' },
  setup_command_failed: { responsibility: 'user', reason: 'setup_command' },
  workspace_setup_unknown: { responsibility: 'unknown', reason: 'workspace_unknown' },
} as const satisfies Record<WorkspaceFailureSubtype, CloudAgentFailureClassification>;

/** Fixed expected classifications for every declared admission failure code. */
const ADMISSION_FAILURE_CLASSIFICATIONS = {
  NOT_FOUND: { responsibility: 'platform', reason: 'admission_not_found' },
  BAD_REQUEST: { responsibility: 'user', reason: 'initial_request_invalid' },
  INTERNAL: { responsibility: 'platform', reason: 'admission_internal' },
  PAYMENT_REQUIRED: { responsibility: 'user', reason: 'insufficient_credits' },
  COMPUTE_STOPPING: { responsibility: 'platform', reason: 'admission_compute_stopping' },
  BILLING_UNAVAILABLE: { responsibility: 'platform', reason: 'admission_billing_unavailable' },
  PENDING_QUEUE_FULL: { responsibility: 'platform', reason: 'admission_capacity' },
  FORBIDDEN: { responsibility: 'user', reason: 'admission_forbidden' },
  MODEL_VALIDATION_UNAVAILABLE: {
    responsibility: 'platform',
    reason: 'managed_model_configuration',
  },
  SANDBOX_CONNECT_FAILED: { responsibility: 'platform', reason: 'sandbox_connectivity' },
  WORKSPACE_SETUP_FAILED: { responsibility: 'unknown', reason: 'workspace_unknown' },
  KILO_SERVER_FAILED: { responsibility: 'platform', reason: 'runtime_startup' },
  WRAPPER_START_FAILED: { responsibility: 'platform', reason: 'runtime_startup' },
  WRAPPER_FINALIZING: { responsibility: 'platform', reason: 'session_coordination' },
  UNKNOWN: { responsibility: 'unknown', reason: 'initial_admission_unknown' },
} as const satisfies Record<CloudAgentAdmissionFailureCode, CloudAgentFailureClassification>;

const SETUP_STAGES = [
  'sandbox_identity',
  'registration',
  'initial_admission',
  'transport',
] as const;
const SETUP_CODES = [
  'sandbox_id_derivation_failed',
  'do_registration_rejected',
  'initial_admission_rejected',
  'initial_queue_full',
  'invalid_initial_intent',
  'do_rpc_outcome_unknown',
] as const;
const SETUP_ADMISSION_CODES = [...CLOUD_AGENT_ADMISSION_FAILURE_CODES, undefined] as const;

type SetupFailureInput = {
  stage: (typeof SETUP_STAGES)[number];
  code: (typeof SETUP_CODES)[number];
  admissionCode?: CloudAgentAdmissionFailureCode;
};

/**
 * Hand-written expected setup classification from the contract, independent of
 * the production switch: coordination stages dominate the reported code; the
 * intent/queue codes dominate the admission code on `initial_admission`; every
 * other rejection resolves from the bounded admission code.
 */
function expectedSetupClassification(input: SetupFailureInput): CloudAgentFailureClassification {
  if (input.stage !== 'initial_admission') {
    return { responsibility: 'platform', reason: 'session_coordination' };
  }
  if (input.code === 'invalid_initial_intent') {
    return { responsibility: 'user', reason: 'initial_request_invalid' };
  }
  if (input.code === 'initial_queue_full') {
    return { responsibility: 'platform', reason: 'admission_capacity' };
  }
  return ADMISSION_FAILURE_CLASSIFICATIONS[input.admissionCode ?? 'UNKNOWN'];
}

type AssistantMatrixInput = {
  code: (typeof ASSISTANT_FAILURE_CODES)[number];
  assistantReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
};

type AssistantMatrixMatch = {
  code?: readonly AssistantMatrixInput['code'][];
  assistantReason?: readonly (CloudAgentAssistantFailureReason | undefined)[];
  providerOwnership?: readonly (CloudAgentProviderOwnership | undefined)[];
};

/** Assistant `model_missing` ignores the reason unless a user-action override matches. */
const MODEL_MISSING_MODEL_REASONS = [
  'model_unavailable',
  'provider_authentication',
  'provider_unavailable',
  'timeout',
  'invalid_request',
  'context_limit',
  'output_limit',
  'content_filter',
  'structured_output',
  'unknown',
  undefined,
] as const;

/**
 * Expected classifications written as fixed data, not as a second copy of
 * `classifyAssistantFailure`. Each row names the distinguishing inputs it
 * covers; an omitted field matches any value. Every row's `expected` is a
 * literal from the contract, so a changed classifier cell fails the matrix
 * instead of being absorbed by editing a twin in lockstep.
 */
const ASSISTANT_FAILURE_DEFAULT: CloudAgentFailureClassification = {
  responsibility: 'unknown',
  reason: 'assistant_unknown',
};

const ASSISTANT_FAILURE_CLASSIFICATIONS: ReadonlyArray<{
  match: AssistantMatrixMatch;
  expected: CloudAgentFailureClassification;
}> = [
  // `payment_required` is the user's own billing state and ignores every other input.
  {
    match: { code: ['payment_required'] },
    expected: { responsibility: 'user', reason: 'insufficient_credits' },
  },
  {
    match: { code: ['assistant_error'], assistantReason: ['insufficient_credits'] },
    expected: { responsibility: 'user', reason: 'insufficient_credits' },
  },
  {
    match: { code: ['assistant_error'], assistantReason: ['rate_limited'] },
    expected: { responsibility: 'provider', reason: 'rate_limited' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['model_unavailable'],
    },
    expected: { responsibility: 'provider', reason: 'model_unavailable' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['provider_authentication'],
      providerOwnership: ['byok'],
    },
    expected: { responsibility: 'user', reason: 'provider_authentication' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['provider_authentication'],
      providerOwnership: ['managed'],
    },
    expected: { responsibility: 'platform', reason: 'managed_provider_authentication' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['provider_authentication'],
      providerOwnership: ['unknown', undefined],
    },
    expected: { responsibility: 'unknown', reason: 'provider_ownership_unknown' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['timeout'],
      providerOwnership: ['managed'],
    },
    expected: { responsibility: 'provider', reason: 'request_timeout' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['timeout'],
      providerOwnership: ['byok'],
    },
    expected: { responsibility: 'provider', reason: 'request_timeout' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['timeout'],
      providerOwnership: ['unknown', undefined],
    },
    expected: { responsibility: 'provider', reason: 'provider_ownership_unknown' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['provider_unavailable'],
      providerOwnership: ['managed'],
    },
    expected: { responsibility: 'provider', reason: 'managed_provider_unavailable' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['provider_unavailable'],
      providerOwnership: ['byok'],
    },
    expected: { responsibility: 'provider', reason: 'provider_unavailable' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['provider_unavailable'],
      providerOwnership: ['unknown', undefined],
    },
    expected: { responsibility: 'provider', reason: 'provider_ownership_unknown' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['invalid_request'],
      providerOwnership: ['byok'],
    },
    expected: { responsibility: 'user', reason: 'assistant_invalid_request' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['invalid_request'],
      providerOwnership: ['managed'],
    },
    expected: { responsibility: 'platform', reason: 'assistant_invalid_request' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['invalid_request'],
      providerOwnership: ['unknown', undefined],
    },
    expected: { responsibility: 'unknown', reason: 'assistant_invalid_request' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['context_limit'],
    },
    expected: { responsibility: 'provider', reason: 'assistant_context_limit' },
  },
  {
    match: {
      code: ['assistant_error'],
      assistantReason: ['output_limit'],
    },
    expected: { responsibility: 'provider', reason: 'assistant_output_limit' },
  },
  {
    match: { code: ['assistant_error'], assistantReason: ['content_filter'] },
    expected: { responsibility: 'user', reason: 'assistant_content_filter' },
  },
  {
    match: { code: ['assistant_error'], assistantReason: ['structured_output'] },
    expected: { responsibility: 'platform', reason: 'assistant_structured_output' },
  },
  // `model_missing` resolves to the unavailable-model branch for every reason except the overrides above.
  {
    match: { code: ['model_missing'], assistantReason: ['insufficient_credits'] },
    expected: { responsibility: 'user', reason: 'insufficient_credits' },
  },
  {
    match: { code: ['model_missing'], assistantReason: ['rate_limited'] },
    expected: { responsibility: 'provider', reason: 'rate_limited' },
  },
  {
    match: {
      code: ['model_missing'],
      assistantReason: MODEL_MISSING_MODEL_REASONS,
    },
    expected: { responsibility: 'provider', reason: 'model_unavailable' },
  },
];

function matchesAssistantMatrix(match: AssistantMatrixMatch, input: AssistantMatrixInput): boolean {
  return (
    (match.code?.includes(input.code) ?? true) &&
    (match.assistantReason?.includes(input.assistantReason) ?? true) &&
    (match.providerOwnership?.includes(input.providerOwnership) ?? true)
  );
}

describe('classifyCloudAgentFailure ownership matrix', () => {
  it('covers every declared run failure code', () => {
    const covered = new Set<string>([
      ...Object.keys(NON_ASSISTANT_FAILURE_CLASSIFICATIONS),
      ...ASSISTANT_FAILURE_CODES,
    ]);
    expect(covered).toEqual(new Set(CLOUD_AGENT_FAILURE_CODES));
  });

  it('emits the fixed classification for every non-assistant code and assistant input', () => {
    for (const [code, expected] of Object.entries(NON_ASSISTANT_FAILURE_CLASSIFICATIONS)) {
      for (const assistantReason of OWNERSHIP_MATRIX_INPUTS.assistantReasons) {
        for (const providerOwnership of OWNERSHIP_MATRIX_INPUTS.providerOwnerships) {
          expect(
            classifyCloudAgentFailure({
              source: 'run',
              stage: 'agent_activity',
              code: code as CloudAgentFailureCode,
              assistantReason,
              providerOwnership,
            })
          ).toEqual(expected);
        }
      }
    }
  });

  it('emits the fixed classification for every assistant code combination', () => {
    for (const code of ASSISTANT_FAILURE_CODES) {
      for (const assistantReason of OWNERSHIP_MATRIX_INPUTS.assistantReasons) {
        for (const providerOwnership of OWNERSHIP_MATRIX_INPUTS.providerOwnerships) {
          const input = { code, assistantReason, providerOwnership };
          const matches = ASSISTANT_FAILURE_CLASSIFICATIONS.filter(row =>
            matchesAssistantMatrix(row.match, input)
          );
          expect(matches.length).toBeLessThanOrEqual(1);
          const expected = matches[0]?.expected ?? ASSISTANT_FAILURE_DEFAULT;

          expect(
            classifyCloudAgentFailure({
              source: 'run',
              stage: 'agent_activity',
              ...input,
            })
          ).toEqual(expected);
        }
      }
    }
  });

  it('covers every declared workspace failure subtype', () => {
    expect(new Set(Object.keys(WORKSPACE_FAILURE_CLASSIFICATIONS))).toEqual(
      new Set(WORKSPACE_FAILURE_SUBTYPES)
    );
  });

  it('emits the fixed classification for every workspace subtype and assistant input', () => {
    for (const workspaceSubtype of WORKSPACE_FAILURE_SUBTYPES) {
      for (const assistantReason of OWNERSHIP_MATRIX_INPUTS.assistantReasons) {
        for (const providerOwnership of OWNERSHIP_MATRIX_INPUTS.providerOwnerships) {
          expect(
            classifyCloudAgentFailure({
              source: 'run',
              stage: 'pre_dispatch',
              code: 'workspace_setup_failed',
              workspaceSubtype,
              assistantReason,
              providerOwnership,
            })
          ).toEqual(WORKSPACE_FAILURE_CLASSIFICATIONS[workspaceSubtype]);
        }
      }
    }
  });

  it('covers every declared admission failure code', () => {
    expect(new Set(Object.keys(ADMISSION_FAILURE_CLASSIFICATIONS))).toEqual(
      new Set(CLOUD_AGENT_ADMISSION_FAILURE_CODES)
    );
  });

  it('emits the fixed classification for every setup stage, code, and admission code', () => {
    for (const stage of SETUP_STAGES) {
      for (const code of SETUP_CODES) {
        for (const admissionCode of SETUP_ADMISSION_CODES) {
          const input = { stage, code, admissionCode };
          expect(classifyCloudAgentFailure({ source: 'setup', ...input })).toEqual(
            expectedSetupClassification(input)
          );
        }
      }
    }
  });

  it('resolves setup stage and code precedence from fixed expected cases', () => {
    const cases = [
      {
        input: { stage: 'transport', code: 'invalid_initial_intent' },
        expected: { responsibility: 'platform', reason: 'session_coordination' },
      },
      {
        input: {
          stage: 'sandbox_identity',
          code: 'initial_admission_rejected',
          admissionCode: 'INTERNAL',
        },
        expected: { responsibility: 'platform', reason: 'session_coordination' },
      },
      {
        input: {
          stage: 'initial_admission',
          code: 'invalid_initial_intent',
          admissionCode: 'PAYMENT_REQUIRED',
        },
        expected: { responsibility: 'user', reason: 'initial_request_invalid' },
      },
      {
        input: {
          stage: 'initial_admission',
          code: 'initial_queue_full',
          admissionCode: 'INTERNAL',
        },
        expected: { responsibility: 'platform', reason: 'admission_capacity' },
      },
      {
        input: {
          stage: 'initial_admission',
          code: 'initial_admission_rejected',
          admissionCode: 'SANDBOX_CONNECT_FAILED',
        },
        expected: { responsibility: 'platform', reason: 'sandbox_connectivity' },
      },
      {
        input: { stage: 'initial_admission', code: 'initial_admission_rejected' },
        expected: { responsibility: 'unknown', reason: 'initial_admission_unknown' },
      },
    ] as const;

    for (const { input, expected } of cases) {
      expect(classifyCloudAgentFailure({ source: 'setup', ...input })).toEqual(expected);
    }
  });
});

describe('CloudAgentFailureResponsibilitySchema', () => {
  it('accepts provider alongside the existing responsibilities', () => {
    expect(CLOUD_AGENT_FAILURE_RESPONSIBILITIES).toEqual([
      'platform',
      'provider',
      'user',
      'unknown',
    ]);
    expect(CloudAgentFailureResponsibilitySchema.parse('provider')).toBe('provider');
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
