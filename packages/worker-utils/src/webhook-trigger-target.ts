import { cloudAgentSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';

export const webhookTriggerTargetSchema = z.enum([
  'cloud_agent',
  'cloud_agent_chat',
  'kiloclaw_chat',
]);
export type WebhookTriggerTarget = z.infer<typeof webhookTriggerTargetSchema>;

export const triggerChatIdSchema = cloudAgentSessionIdSchema;
export const triggerChatIdRequired = 'Enter the Cloud Agent chat ID (workspace_…).';
export const triggerChatRequiresCreator =
  'Organization triggers for an existing chat must run as their creator.';

export const existingChatWorkspaceSettings = [
  'githubRepo',
  'profileId',
  'environmentId',
  'sandboxAllocation',
  'kiloclawInstanceId',
] as const;

export function hasExistingChatWorkspaceSettings(
  input: Partial<Record<(typeof existingChatWorkspaceSettings)[number], unknown>>
): boolean {
  return existingChatWorkspaceSettings.some(field => input[field] != null);
}

export const existingChatWorkspaceSettingsError =
  'An existing chat uses its workspace settings. Do not specify a repository, profile, environment, sandbox, or KiloClaw instance.';
