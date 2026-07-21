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

export const CLOUD_AGENT_FAILURE_RESPONSIBILITIES = ['platform', 'user', 'unknown'] as const;
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
  'sandbox_capacity',
  'sandbox_connectivity',
  'runtime_startup',
  'wrapper_liveness',
  'delivery',
  'managed_provider_unavailable',
  'managed_provider_authentication',
  'managed_model_configuration',
  'provider_unavailable',
  'source_control_network',
  'assistant_unknown',
  'workspace_unknown',
  'session_coordination',
  'initial_request_invalid',
  'initial_admission_unknown',
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
  'timeout',
  'invalid_request',
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
  managedModelSelection?: boolean;
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
    case 'setup_command_failed':
      return classified('user', 'setup_command');
    case 'sandbox_storage_full':
      return classified('platform', 'sandbox_capacity');
    case 'git_clone_timeout':
    case 'git_checkout_timeout':
    case 'git_network_failed':
    case 'git_pack_corrupt':
      return classified('unknown', 'source_control_network');
    case 'kilo_import_timeout':
    case 'kilo_import_failed':
    case 'workspace_setup_unknown':
    case undefined:
      return classified('unknown', 'workspace_unknown');
  }
}

function classifyAssistantFailure(input: RunFailureFacts): CloudAgentFailureClassification {
  if (input.code === 'payment_required' || input.assistantReason === 'insufficient_credits') {
    return classified('user', 'insufficient_credits');
  }
  if (input.assistantReason === 'rate_limited') return classified('user', 'rate_limited');
  if (input.code === 'model_missing' || input.assistantReason === 'model_unavailable') {
    return input.managedModelSelection
      ? classified('platform', 'managed_model_configuration')
      : classified('user', 'model_unavailable');
  }
  if (input.assistantReason === 'provider_authentication') {
    if (input.providerOwnership === 'byok') {
      return classified('user', 'provider_authentication');
    }
    if (input.providerOwnership === 'managed') {
      return classified('platform', 'managed_provider_authentication');
    }
    return classified('unknown', 'assistant_unknown');
  }
  if (input.assistantReason === 'provider_unavailable' || input.assistantReason === 'timeout') {
    return input.providerOwnership === 'managed'
      ? classified('platform', 'managed_provider_unavailable')
      : classified('unknown', 'provider_unavailable');
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
    if (input.stage === 'initial_admission') {
      return classified('unknown', 'initial_admission_unknown');
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
    case 'wrapper_no_output':
    case 'wrapper_ping_timeout':
    case 'wrapper_error_before_activity':
    case 'wrapper_error_after_activity':
    case 'missing_assistant_reply':
      return classified('platform', 'wrapper_liveness');
    case 'assistant_error':
    case 'payment_required':
    case 'model_missing':
      return classifyAssistantFailure(input);
    case 'unclassified':
      return classified('unknown', 'unclassified');
    case 'user_interrupt':
    case 'container_shutdown':
    case 'system_interrupt':
      return classified('unknown', 'unclassified');
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
