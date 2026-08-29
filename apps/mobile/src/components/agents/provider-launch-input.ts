import {
  type LaunchRepositoryReference,
  repositoryResourceKey,
  requireLaunchRepository,
} from '@kilocode/app-shared/code-review/repository-identity';
import { type PrepareInput } from '@kilocode/cloud-agent-sdk/session-manager';
import * as z from 'zod';

import { type AgentAttachmentWire } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type OutboxRow } from '@/lib/persist/mutation-outbox';
import { type AgentMode } from './mode-normalize';
import { type NewSessionRepository } from './new-session-repository-state';

const legacyAttachmentsSchema = z.strictObject({ path: z.string(), files: z.array(z.string()) });
const legacyBitbucketRepositorySchema = z.strictObject({
  fullName: z.string(),
  workspaceUuid: z.string(),
  repositoryUuid: z.string(),
});
const legacyLaunchInputSchema = z.strictObject({
  prompt: z.string().optional(),
  initialMessageId: z.string().min(1).optional(),
  cloneFromKiloSessionId: z.string().optional(),
  mode: z.string(),
  model: z.string(),
  variant: z.string().optional(),
  autoCommit: z.boolean(),
  autoInitiate: z.literal(true),
  operationKey: z.string().min(1),
  profileId: z.string().optional(),
  attachments: legacyAttachmentsSchema.optional(),
  githubRepo: z.string().optional(),
  gitlabProject: z.string().optional(),
  bitbucketRepo: legacyBitbucketRepositorySchema.optional(),
});

// Old unpinned outbox inputs retain their admitted settings, not the current
// selection's pins. Remove after old clients/records disappear and the 30-day
// ledger window expires.
export function restoreLegacyLaunchInput<
  T extends { operationKey: string; initialMessageId?: string },
>(row: OutboxRow, input: T): T | null {
  const stored = legacyLaunchInputSchema.safeParse(row.input);
  if (
    row.taxonomy !== 'safe-retry' ||
    !stored.success ||
    stored.data.operationKey !== row.operationKey
  ) {
    return null;
  }
  const restored = { ...input, operationKey: row.operationKey };
  if (input.initialMessageId !== undefined && stored.data.initialMessageId !== undefined) {
    restored.initialMessageId = stored.data.initialMessageId;
  }
  const expected = legacyLaunchInputSchema.safeParse(restored);
  // Parsing both sides gives a stable field order and rejects unknown intent fields.
  return expected.success && JSON.stringify(expected.data) === JSON.stringify(stored.data)
    ? restored
    : null;
}

export type ProviderLaunchSelection = {
  reference: LaunchRepositoryReference;
  upstreamBranch?: string;
};

export function getProviderLaunchFingerprint(
  accountId: string,
  selection: ProviderLaunchSelection
) {
  return JSON.stringify([
    'provider-launch:v1',
    repositoryResourceKey(accountId, selection.reference),
    selection.upstreamBranch ?? null,
  ]);
}

export type ProviderPrepareInput = Pick<
  PrepareInput,
  | 'githubRepo'
  | 'githubIntegrationId'
  | 'gitlabProject'
  | 'gitlabIntegrationId'
  | 'gitlabInstanceUrl'
  | 'bitbucketRepo'
  | 'bitbucketIntegrationId'
  | 'upstreamBranch'
>;

export type NewSessionPrepareInput = ProviderPrepareInput & {
  prompt: string;
  initialMessageId: string;
  mode: AgentMode;
  model: string;
  variant: string | undefined;
  autoCommit: boolean;
  autoInitiate: boolean;
  operationKey: string;
  profileId?: string;
  attachments?: AgentAttachmentWire;
};

export type ProviderLaunchContext = {
  launchSelection?: ProviderLaunchSelection | null;
  accountId?: string;
  organizationId?: string;
};

export function isProviderLaunchSelectionCurrent({
  launchSelection,
  accountId,
  organizationId,
}: ProviderLaunchContext): boolean {
  // Old picker callers omit normalized selection. Remove only after old clients
  // and records disappear and the 30-day ledger window expires.
  if (launchSelection === undefined) {
    return true;
  }
  if (!launchSelection || !accountId) {
    return false;
  }
  const { reference, upstreamBranch } = launchSelection;
  const { owner } = reference.authorization;
  return (
    owner.type === (organizationId ? 'org' : 'user') &&
    owner.id === (organizationId ?? accountId) &&
    (reference.repository.provider !== 'bitbucket' || Boolean(organizationId)) &&
    (upstreamBranch === undefined || upstreamBranch.trim().length > 0)
  );
}

export function resolveProviderLaunchInput(
  repository: NewSessionRepository | null,
  context: ProviderLaunchContext
) {
  if (!repository || !isProviderLaunchSelectionCurrent(context)) {
    return null;
  }
  const { launchSelection, accountId } = context;
  const reference = launchSelection ? requireLaunchRepository(launchSelection.reference) : null;
  if (
    reference &&
    (reference.repository.provider !== repository.platform ||
      reference.repository.fullName !== repository.fullName)
  ) {
    return null;
  }
  const input: ProviderPrepareInput = {};
  const integrationId = reference?.authorization.integrationId;
  if (repository.platform === 'github') {
    input.githubRepo = repository.fullName;
    if (integrationId) {
      input.githubIntegrationId = integrationId;
    }
  } else if (repository.platform === 'gitlab') {
    input.gitlabProject = repository.fullName;
    if (integrationId) {
      input.gitlabIntegrationId = integrationId;
      input.gitlabInstanceUrl = reference.repository.instanceUrl;
    }
  } else {
    const identity = reference?.repository;
    const workspaceUuid =
      identity?.provider === 'bitbucket' ? identity.workspaceUuid : repository.workspaceUuid;
    const repositoryUuid = identity?.repositoryId ?? repository.repositoryUuid;
    if (
      !workspaceUuid ||
      !repositoryUuid ||
      (reference && repository.workspaceUuid && repository.workspaceUuid !== workspaceUuid) ||
      (reference && repository.repositoryUuid && repository.repositoryUuid !== repositoryUuid)
    ) {
      return null;
    }
    input.bitbucketRepo = { fullName: repository.fullName, workspaceUuid, repositoryUuid };
    if (integrationId) {
      input.bitbucketIntegrationId = integrationId;
    }
  }
  if (launchSelection?.upstreamBranch !== undefined) {
    input.upstreamBranch = launchSelection.upstreamBranch;
  }
  // Old picker rows retain their exact retry bytes and server-side unpinned
  // lookup until old clients/records and the 30-day ledger window expire.
  if (reference && accountId) {
    return {
      input,
      fingerprint: getProviderLaunchFingerprint(accountId, {
        reference,
        upstreamBranch: input.upstreamBranch,
      }),
    };
  }
  const fingerprint =
    repository.platform === 'bitbucket'
      ? {
          platform: repository.platform,
          fullName: repository.fullName,
          workspaceUuid: repository.workspaceUuid ?? null,
          repositoryUuid: repository.repositoryUuid ?? null,
        }
      : { platform: repository.platform, fullName: repository.fullName };
  return { input, fingerprint };
}
