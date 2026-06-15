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
