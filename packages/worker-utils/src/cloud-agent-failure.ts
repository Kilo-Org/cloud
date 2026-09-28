import { z } from 'zod';

export const CLOUD_AGENT_FAILURE_STAGES = [
  'pre_dispatch',
  'post_dispatch_no_activity',
  'agent_activity',
  'interruption',
  'unknown',
] as const;

export const CloudAgentFailureStageSchema = z.enum(CLOUD_AGENT_FAILURE_STAGES);
export type CloudAgentFailureStage = z.infer<typeof CloudAgentFailureStageSchema>;

export const CLOUD_AGENT_FAILURE_CODES = [
  'sandbox_connect_failed',
  'workspace_setup_failed',
  'kilo_server_failed',
  'wrapper_start_failed',
  'invalid_delivery_request',
  'session_metadata_missing',
  'model_missing',
  'delivery_failure_unknown',
  'wrapper_disconnected',
  'wrapper_no_output',
  'wrapper_ping_timeout',
  'wrapper_error_before_activity',
  'assistant_error',
  'wrapper_error_after_activity',
  'missing_assistant_reply',
  'payment_required',
  'admission_billing_unavailable',
  'user_interrupt',
  'container_shutdown',
  'system_interrupt',
  'unclassified',
] as const;

export const CloudAgentFailureCodeSchema = z.enum(CLOUD_AGENT_FAILURE_CODES);
export type CloudAgentFailureCode = z.infer<typeof CloudAgentFailureCodeSchema>;

export const WORKSPACE_FAILURE_SUBTYPES = [
  'git_clone_timeout',
  'git_checkout_timeout',
  'git_authentication_failed',
  'git_rate_limited',
  'git_network_failed',
  'git_pack_corrupt',
  'git_checkout_conflict',
  'git_branch_missing',
  'sandbox_storage_full',
  'kilo_import_timeout',
  'kilo_import_failed',
  'setup_command_timeout',
  'setup_command_failed',
  'workspace_setup_unknown',
] as const;

export const WorkspaceFailureSubtypeSchema = z.enum(WORKSPACE_FAILURE_SUBTYPES);
export type WorkspaceFailureSubtype = z.infer<typeof WorkspaceFailureSubtypeSchema>;

const USER_FAILURE_MESSAGES = {
  sandbox_connect_failed: 'Could not connect to the sandbox',
  workspace_setup_failed: 'Workspace setup failed',
  kilo_server_failed: 'Kilo server failed to start',
  wrapper_start_failed: 'Agent wrapper failed to start',
  invalid_delivery_request: 'The message could not be delivered',
  session_metadata_missing: 'Session metadata is unavailable',
  model_missing: 'No model was selected',
  delivery_failure_unknown: 'The message could not be delivered',
  wrapper_disconnected: 'Agent wrapper disconnected',
  wrapper_no_output: 'Agent wrapper made no execution progress during the watchdog window',
  wrapper_ping_timeout: 'Agent wrapper stopped responding',
  wrapper_error_before_activity: 'Agent wrapper failed before processing the message',
  assistant_error: 'Assistant request failed',
  wrapper_error_after_activity: 'Agent wrapper failed while processing the message',
  missing_assistant_reply: 'No assistant reply was produced',
  payment_required: 'Assistant request failed: insufficient credits',
  admission_billing_unavailable: 'Sandbox billing is unavailable',
  user_interrupt: 'The message was interrupted by the user',
  container_shutdown: 'The agent container shut down',
  system_interrupt: 'The message was interrupted',
  unclassified: 'The message failed',
} as const satisfies Record<CloudAgentFailureCode, string>;

const WORKSPACE_FAILURE_MESSAGES = {
  git_clone_timeout: 'Repository clone timed out',
  git_checkout_timeout: 'Repository checkout timed out',
  git_authentication_failed: 'Repository authentication failed',
  git_rate_limited: 'Repository request was rate limited',
  git_network_failed: 'Repository network request failed',
  git_pack_corrupt: 'Repository data is corrupt',
  git_checkout_conflict: 'Repository checkout conflict',
  git_branch_missing: 'Requested repository branch was not found',
  sandbox_storage_full: 'Workspace setup failed: sandbox storage full',
  kilo_import_timeout: 'Session import timed out',
  kilo_import_failed: 'Session import failed',
  setup_command_timeout: 'Setup command timed out',
  setup_command_failed: 'Setup command failed',
  workspace_setup_unknown: 'Workspace setup failed',
} as const satisfies Record<WorkspaceFailureSubtype, string>;

export function userVisibleFailureMessage(code: CloudAgentFailureCode): string {
  return USER_FAILURE_MESSAGES[code];
}

export function workspaceFailureUserMessage(subtype: WorkspaceFailureSubtype): string {
  return WORKSPACE_FAILURE_MESSAGES[subtype];
}

export const CLOUD_AGENT_SESSION_FAILURE_CODES = [
  'sandbox_id_derivation_failed',
  'do_registration_rejected',
  'initial_admission_rejected',
  'initial_queue_full',
  'invalid_initial_intent',
  'do_rpc_outcome_unknown',
] as const;

export const CloudAgentSessionFailureCodeSchema = z.enum(CLOUD_AGENT_SESSION_FAILURE_CODES);
export type CloudAgentSessionFailureCode = z.infer<typeof CloudAgentSessionFailureCodeSchema>;

export const CLOUD_AGENT_SESSION_FAILURE_STAGES = [
  'sandbox_identity',
  'registration',
  'initial_admission',
  'transport',
] as const;

export const CloudAgentSessionFailureStageSchema = z.enum(CLOUD_AGENT_SESSION_FAILURE_STAGES);
export type CloudAgentSessionFailureStage = z.infer<typeof CloudAgentSessionFailureStageSchema>;

export const SESSION_FAILURE_MESSAGES = {
  sandbox_id_derivation_failed: 'Could not create the session (sandbox identity)',
  do_registration_rejected: 'Could not create the session (registration rejected)',
  initial_admission_rejected: 'Environment preparation failed (admission rejected)',
  initial_queue_full: 'Environment preparation failed (queue full)',
  invalid_initial_intent: 'Environment preparation failed (invalid initial request)',
  do_rpc_outcome_unknown: 'Session creation outcome is unknown (transport failure)',
} as const satisfies Record<CloudAgentSessionFailureCode, string>;

export function userVisibleSessionFailureMessage(code: CloudAgentSessionFailureCode): string {
  return SESSION_FAILURE_MESSAGES[code];
}

/**
 * Bounded admission-result codes carried across the setup failure boundary so
 * the classifier can attribute an `initial_admission` rejection. `UNKNOWN` is a
 * runtime sentinel for a code this version does not recognise.
 */
export const CLOUD_AGENT_ADMISSION_FAILURE_CODES = [
  'NOT_FOUND',
  'BAD_REQUEST',
  'INTERNAL',
  'PAYMENT_REQUIRED',
  'COMPUTE_STOPPING',
  'BILLING_UNAVAILABLE',
  'PENDING_QUEUE_FULL',
  'FORBIDDEN',
  'MODEL_VALIDATION_UNAVAILABLE',
  'SANDBOX_CONNECT_FAILED',
  'WORKSPACE_SETUP_FAILED',
  'KILO_SERVER_FAILED',
  'WRAPPER_START_FAILED',
  'WRAPPER_FINALIZING',
  'UNKNOWN',
] as const;
export const CloudAgentAdmissionFailureCodeSchema = z.enum(CLOUD_AGENT_ADMISSION_FAILURE_CODES);
export type CloudAgentAdmissionFailureCode = z.infer<typeof CloudAgentAdmissionFailureCodeSchema>;

const KNOWN_ADMISSION_FAILURE_CODES = new Set<string>(CLOUD_AGENT_ADMISSION_FAILURE_CODES);

export function toAdmissionFailureCode(code: string | undefined): CloudAgentAdmissionFailureCode {
  return code !== undefined && KNOWN_ADMISSION_FAILURE_CODES.has(code)
    ? (code as CloudAgentAdmissionFailureCode)
    : 'UNKNOWN';
}

export const CLOUD_AGENT_FAILURE_RESPONSIBILITIES = [
  'platform',
  'provider',
  'user',
  'unknown',
] as const;
export const CloudAgentFailureResponsibilitySchema = z.enum(CLOUD_AGENT_FAILURE_RESPONSIBILITIES);
export type CloudAgentFailureResponsibility = z.infer<typeof CloudAgentFailureResponsibilitySchema>;

export const CLOUD_AGENT_FAILURE_REASONS = [
  'insufficient_credits',
  'rate_limited',
  'model_unavailable',
  'provider_authentication',
  'setup_command',
  'source_control_authentication',
  'source_control_configuration',
  'source_control_clone_timeout',
  'source_control_checkout_timeout',
  'source_control_repository_corrupt',
  'sandbox_capacity',
  'sandbox_connectivity',
  'runtime_startup',
  'wrapper_liveness',
  'delivery',
  'managed_provider_unavailable',
  'managed_provider_authentication',
  'managed_model_configuration',
  'provider_unavailable',
  'provider_disconnect',
  'gateway_unavailable',
  'request_timeout',
  'assistant_invalid_request',
  'assistant_context_limit',
  'assistant_output_limit',
  'assistant_content_filter',
  'assistant_structured_output',
  'provider_ownership_unknown',
  'source_control_network',
  'assistant_unknown',
  'wrapper_disconnected',
  'wrapper_startup',
  'wrapper_crash',
  'assistant_no_reply',
  'user_interrupt',
  'container_shutdown',
  'system_interrupt',
  'workspace_unknown',
  'session_import_timeout',
  'session_import_failed',
  'setup_command_timeout',
  'admission_capacity',
  'admission_not_found',
  'admission_internal',
  'admission_compute_stopping',
  'admission_billing_unavailable',
  'admission_forbidden',
  'session_coordination',
  'initial_request_invalid',
  'initial_admission_unknown',
  // Deprecated producer values: the classifier now emits the `assistant_*`
  // reasons above. Retained so historical rows in the unconstrained text column
  // still resolve to a label instead of rendering blank for the retention window.
  'invalid_request',
  'context_limit',
  'output_limit',
  'content_filter',
  'structured_output',
  'unclassified',
] as const;
export const CloudAgentFailureReasonSchema = z.enum(CLOUD_AGENT_FAILURE_REASONS);
export type CloudAgentFailureReason = z.infer<typeof CloudAgentFailureReasonSchema>;

export const CLOUD_AGENT_PROVIDER_OWNERSHIPS = ['managed', 'byok', 'unknown'] as const;
export const CloudAgentProviderOwnershipSchema = z.enum(CLOUD_AGENT_PROVIDER_OWNERSHIPS);
export type CloudAgentProviderOwnership = z.infer<typeof CloudAgentProviderOwnershipSchema>;

export const CLOUD_AGENT_ASSISTANT_FAILURE_REASONS = [
  'insufficient_credits',
  'rate_limited',
  'model_unavailable',
  'provider_authentication',
  'provider_unavailable',
  'provider_disconnect',
  'gateway_unavailable',
  'timeout',
  'invalid_request',
  'context_limit',
  'output_limit',
  'content_filter',
  'structured_output',
  'unknown',
] as const;
export const CloudAgentAssistantFailureReasonSchema = z.enum(CLOUD_AGENT_ASSISTANT_FAILURE_REASONS);
export type CloudAgentAssistantFailureReason = z.infer<
  typeof CloudAgentAssistantFailureReasonSchema
>;

export type CloudAgentFailureClassification = {
  responsibility: CloudAgentFailureResponsibility;
  reason: CloudAgentFailureReason;
};

type RunFailureFacts = {
  source: 'run';
  stage: CloudAgentFailureStage;
  code: CloudAgentFailureCode;
  workspaceSubtype?: WorkspaceFailureSubtype;
  assistantReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
};

type SetupFailureFacts = {
  source: 'setup';
  stage: 'sandbox_identity' | 'registration' | 'initial_admission' | 'transport';
  code:
    | 'sandbox_id_derivation_failed'
    | 'do_registration_rejected'
    | 'initial_admission_rejected'
    | 'initial_queue_full'
    | 'invalid_initial_intent'
    | 'do_rpc_outcome_unknown';
  admissionCode?: CloudAgentAdmissionFailureCode;
};

function classified(
  responsibility: CloudAgentFailureResponsibility,
  reason: CloudAgentFailureReason
): CloudAgentFailureClassification {
  return { responsibility, reason };
}

function classifyWorkspaceFailure(
  subtype: WorkspaceFailureSubtype | undefined
): CloudAgentFailureClassification {
  switch (subtype) {
    case 'git_authentication_failed':
      return classified('user', 'source_control_authentication');
    case 'git_checkout_conflict':
    case 'git_branch_missing':
      return classified('user', 'source_control_configuration');
    case 'setup_command_timeout':
      return classified('user', 'setup_command_timeout');
    case 'setup_command_failed':
      return classified('user', 'setup_command');
    case 'sandbox_storage_full':
      return classified('platform', 'sandbox_capacity');
    case 'git_rate_limited':
      return classified('platform', 'rate_limited');
    case 'git_clone_timeout':
      return classified('platform', 'source_control_clone_timeout');
    case 'git_checkout_timeout':
      return classified('platform', 'source_control_checkout_timeout');
    case 'git_network_failed':
      return classified('platform', 'source_control_network');
    case 'git_pack_corrupt':
      return classified('platform', 'source_control_repository_corrupt');
    case 'kilo_import_timeout':
      return classified('platform', 'session_import_timeout');
    case 'kilo_import_failed':
      return classified('platform', 'session_import_failed');
    case 'workspace_setup_unknown':
    case undefined:
      return classified('unknown', 'workspace_unknown');
  }
}

function classifyAdmissionFailure(
  admissionCode: CloudAgentAdmissionFailureCode | undefined
): CloudAgentFailureClassification {
  switch (admissionCode) {
    case 'NOT_FOUND':
      return classified('platform', 'admission_not_found');
    case 'INTERNAL':
      return classified('platform', 'admission_internal');
    case 'PAYMENT_REQUIRED':
      return classified('user', 'insufficient_credits');
    case 'COMPUTE_STOPPING':
      return classified('platform', 'admission_compute_stopping');
    case 'BILLING_UNAVAILABLE':
      return classified('platform', 'admission_billing_unavailable');
    case 'PENDING_QUEUE_FULL':
      return classified('platform', 'admission_capacity');
    case 'FORBIDDEN':
      return classified('user', 'admission_forbidden');
    case 'MODEL_VALIDATION_UNAVAILABLE':
      return classified('platform', 'managed_model_configuration');
    case 'SANDBOX_CONNECT_FAILED':
      return classified('platform', 'sandbox_connectivity');
    case 'WORKSPACE_SETUP_FAILED':
      return classified('unknown', 'workspace_unknown');
    case 'KILO_SERVER_FAILED':
    case 'WRAPPER_START_FAILED':
      return classified('platform', 'runtime_startup');
    case 'WRAPPER_FINALIZING':
      return classified('platform', 'session_coordination');
    case 'BAD_REQUEST':
      return classified('user', 'initial_request_invalid');
    case 'UNKNOWN':
    case undefined:
      return classified('unknown', 'initial_admission_unknown');
  }
}

/**
 * The model-serving path is one `provider` bucket: our gateway and the upstream
 * provider are indistinguishable from the cloud agent's point of view, so
 * ownership does not change the responsibility for a provider outage, rate
 * limit, timeout or model-availability failure. Only a failure whose handling
 * the cloud agent platform itself controls stays `platform`.
 */
function classifyAssistantFailure(input: RunFailureFacts): CloudAgentFailureClassification {
  if (input.code === 'payment_required' || input.assistantReason === 'insufficient_credits') {
    return classified('user', 'insufficient_credits');
  }
  if (input.assistantReason === 'rate_limited') return classified('provider', 'rate_limited');
  if (input.code === 'model_missing' || input.assistantReason === 'model_unavailable') {
    return classified('provider', 'model_unavailable');
  }
  if (input.assistantReason === 'provider_authentication') {
    if (input.providerOwnership === 'byok') {
      return classified('user', 'provider_authentication');
    }
    if (input.providerOwnership === 'managed') {
      return classified('platform', 'managed_provider_authentication');
    }
    return classified('unknown', 'provider_ownership_unknown');
  }
  if (input.assistantReason === 'timeout') {
    if (input.providerOwnership === 'unknown' || input.providerOwnership === undefined) {
      return classified('provider', 'provider_ownership_unknown');
    }
    return classified('provider', 'request_timeout');
  }
  if (input.assistantReason === 'provider_unavailable') {
    if (input.providerOwnership === 'managed') {
      return classified('provider', 'managed_provider_unavailable');
    }
    return input.providerOwnership === 'byok'
      ? classified('provider', 'provider_unavailable')
      : classified('provider', 'provider_ownership_unknown');
  }
  if (input.assistantReason === 'provider_disconnect') {
    return classified('provider', 'provider_disconnect');
  }
  if (input.assistantReason === 'gateway_unavailable') {
    // The gateway's own `temporarily_unavailable` (our over-limit guard or our
    // managed-provider payment failure). Kept on the model-serving path as one
    // provider bucket: the distinct reason exists so the component is visible in
    // triage, not to move the platform share. Re-attributing this to `platform`
    // is a deliberate metric change, tracked separately.
    return classified('provider', 'gateway_unavailable');
  }
  if (input.assistantReason === 'context_limit') {
    return classified('provider', 'assistant_context_limit');
  }
  if (input.assistantReason === 'output_limit') {
    return classified('provider', 'assistant_output_limit');
  }
  if (input.assistantReason === 'invalid_request') {
    const responsibility =
      input.providerOwnership === 'byok'
        ? 'user'
        : input.providerOwnership === 'managed'
          ? 'platform'
          : 'unknown';
    return classified(responsibility, 'assistant_invalid_request');
  }
  if (input.assistantReason === 'content_filter') {
    return classified('user', 'assistant_content_filter');
  }
  if (input.assistantReason === 'structured_output') {
    return classified('platform', 'assistant_structured_output');
  }
  return classified('unknown', 'assistant_unknown');
}

/** Maps only bounded structured facts to the stable reporting taxonomy. */
export function classifyCloudAgentFailure(
  input: RunFailureFacts | SetupFailureFacts
): CloudAgentFailureClassification {
  if (input.source === 'setup') {
    if (
      input.stage === 'sandbox_identity' ||
      input.stage === 'registration' ||
      input.stage === 'transport'
    ) {
      return classified('platform', 'session_coordination');
    }
    if (input.code === 'invalid_initial_intent') {
      return classified('user', 'initial_request_invalid');
    }
    if (input.code === 'initial_queue_full') {
      return classified('platform', 'admission_capacity');
    }
    if (input.stage === 'initial_admission') {
      return classifyAdmissionFailure(input.admissionCode);
    }
    return classified('unknown', 'unclassified');
  }

  switch (input.code) {
    case 'workspace_setup_failed':
      return classifyWorkspaceFailure(input.workspaceSubtype);
    case 'sandbox_connect_failed':
      return classified('platform', 'sandbox_connectivity');
    case 'kilo_server_failed':
    case 'wrapper_start_failed':
      return classified('platform', 'runtime_startup');
    case 'invalid_delivery_request':
    case 'session_metadata_missing':
    case 'delivery_failure_unknown':
      return classified('platform', 'delivery');
    case 'wrapper_disconnected':
      return classified('platform', 'wrapper_disconnected');
    case 'wrapper_no_output':
    case 'wrapper_ping_timeout':
      return classified('platform', 'wrapper_liveness');
    case 'wrapper_error_before_activity':
      return classified('platform', 'wrapper_startup');
    case 'wrapper_error_after_activity':
      return classified('platform', 'wrapper_crash');
    case 'missing_assistant_reply':
      return classified('platform', 'assistant_no_reply');
    case 'assistant_error':
    case 'payment_required':
    case 'model_missing':
      return classifyAssistantFailure(input);
    case 'admission_billing_unavailable':
      return classified('platform', 'admission_billing_unavailable');
    case 'unclassified':
      return classified('unknown', 'unclassified');
    case 'user_interrupt':
      return classified('user', 'user_interrupt');
    case 'container_shutdown':
      return classified('platform', 'container_shutdown');
    case 'system_interrupt':
      return classified('platform', 'system_interrupt');
  }
}

export const CLOUD_AGENT_SAFE_FAILURE_MESSAGE_MAX_LENGTH = 4_096;

export const CloudAgentSafeFailureSchema = z
  .object({
    stage: CloudAgentFailureStageSchema.optional(),
    code: CloudAgentFailureCodeSchema.optional(),
    subtype: WorkspaceFailureSubtypeSchema.optional(),
    attempts: z.number().int().nonnegative().optional(),
    message: z.string().min(1).max(CLOUD_AGENT_SAFE_FAILURE_MESSAGE_MAX_LENGTH).optional(),
    // `assistant_error` is a single code covering every provider-side failure,
    // so on its own it cannot tell rate limiting apart from an outage, and it
    // cannot say whose key was throttled. Both values are already computed by
    // classifyAssistantFailure and persisted on the session message state; these
    // fields carry them across the callback so receivers stop having to infer
    // the reason from the safe message text.
    //
    // Deliberately not covered by a refine. This schema is `.strict()` and
    // CloudAgentCallbackFailureSchema turns any parse failure into `undefined`,
    // which discards the WHOLE failure object (stage, code, subtype, message),
    // not just the offending field. Neither field carries an invariant worth
    // that blast radius.
    assistantReason: CloudAgentAssistantFailureReasonSchema.optional(),
    providerOwnership: CloudAgentProviderOwnershipSchema.optional(),
  })
  .strict()
  .refine(failure => failure.subtype === undefined || failure.code === 'workspace_setup_failed', {
    message: 'Workspace failure subtype requires workspace_setup_failed failure code',
    path: ['subtype'],
  });

export type CloudAgentSafeFailure = z.infer<typeof CloudAgentSafeFailureSchema>;

export const CloudAgentCallbackFailureSchema = z.preprocess(failure => {
  const parsed = CloudAgentSafeFailureSchema.safeParse(failure);
  return parsed.success ? parsed.data : undefined;
}, CloudAgentSafeFailureSchema.optional());

export function isWorkspaceFailureSubtype(value: unknown): value is WorkspaceFailureSubtype {
  return WorkspaceFailureSubtypeSchema.safeParse(value).success;
}
