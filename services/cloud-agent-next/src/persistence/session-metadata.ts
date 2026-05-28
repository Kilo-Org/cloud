import * as z from 'zod';

import { MESSAGE_ID_FORMAT_DESCRIPTION, MESSAGE_ID_PATTERN } from '../session/message-id.js';
import type { SandboxId } from '../types.js';
import {
  AttachmentsSchema,
  branchNameSchema,
  CallbackTargetSchema,
  MetadataSchema as LegacySessionMetadataSchema,
  SessionProfileBundleSchema,
} from './schemas.js';

const SandboxIdSchema = z
  .string()
  .refine(
    s => /^(ses|dind|org|usr|bot|ubt)-[0-9a-f]+$/.test(s) || s.includes('__'),
    'Invalid sandboxId format'
  )
  .transform(s => s as SandboxId);

const MessageIdSchema = z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION);

const MetadataIdentitySchema = z
  .object({
    sessionId: z.string(),
    userId: z.string(),
    orgId: z.string().optional(),
    botId: z.string().optional(),
    createdOnPlatform: z.string().max(100).optional(),
  })
  .strict();

const MetadataAuthSchema = z
  .object({
    kiloSessionId: z.string().optional(),
    kilocodeToken: z.string().optional(),
  })
  .strict();

const RepositoryCommonSchema = {
  token: z.string().optional(),
  upstreamBranch: branchNameSchema.optional(),
};

const MetadataRepositorySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('github'),
      repo: z.string(),
      platform: z.literal('github').optional(),
      githubInstallationId: z.string().optional(),
      githubAppType: z.enum(['standard', 'lite']).optional(),
      ...RepositoryCommonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('gitlab'),
      url: z.string(),
      platform: z.literal('gitlab').optional(),
      gitlabTokenManaged: z.boolean().optional(),
      ...RepositoryCommonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('git'),
      url: z.string(),
      platform: z.enum(['github', 'gitlab']).optional(),
      ...RepositoryCommonSchema,
    })
    .strict(),
]);

const CurrentMetadataInitialTurnSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('prompt'),
      prompt: z.string(),
      attachments: AttachmentsSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      command: z.string().min(1),
      arguments: z.string(),
    })
    .strict(),
]);

const CurrentMetadataInitialMessageSchema = z
  .object({
    id: MessageIdSchema.optional(),
    prompt: z.string().optional(),
    attachments: AttachmentsSchema.optional(),
    turn: CurrentMetadataInitialTurnSchema.optional(),
  })
  .strict();

const MetadataAgentSchema = z
  .object({
    mode: z.string().optional(),
    model: z.string().optional(),
    variant: z
      .string()
      .max(50)
      .regex(/^[a-zA-Z]+$/)
      .optional(),
    appendSystemPrompt: z.string().max(10000).optional(),
  })
  .strict();

const MetadataFinalizationSchema = z
  .object({
    autoCommit: z.boolean().optional(),
    condenseOnComplete: z.boolean().optional(),
    gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),
  })
  .strict();

const MetadataCallbackSchema = z
  .object({
    target: CallbackTargetSchema.optional(),
  })
  .strict();

const MetadataWorkspaceSchema = z
  .object({
    sandboxId: SandboxIdSchema.optional(),
    workspacePath: z.string().optional(),
    sessionHome: z.string().optional(),
    branchName: z.string().optional(),
    shallow: z.boolean().optional(),
    devcontainerRequested: z.boolean().optional(),
  })
  .strict();

const MetadataDevContainerSchema = z
  .object({
    workspacePath: z.string(),
    innerWorkspaceFolder: z.string(),
    wrapperPort: z.number().int().min(1).max(65535),
    configPath: z.string(),
  })
  .strict();

const MetadataLifecycleSchema = z
  .object({
    version: z.number(),
    timestamp: z.number(),
    preparedAt: z.number().optional(),
    initiatedAt: z.number().optional(),
    kiloServerLastActivity: z.number().optional(),
  })
  .strict();

export const CurrentSessionMetadataSchema = z
  .object({
    metadataSchemaVersion: z.literal(2),
    identity: MetadataIdentitySchema,
    auth: MetadataAuthSchema,
    repository: MetadataRepositorySchema.optional(),
    initialMessage: CurrentMetadataInitialMessageSchema.optional(),
    agent: MetadataAgentSchema.optional(),
    finalization: MetadataFinalizationSchema.optional(),
    profile: SessionProfileBundleSchema.optional(),
    callback: MetadataCallbackSchema.optional(),
    workspace: MetadataWorkspaceSchema.optional(),
    devcontainer: MetadataDevContainerSchema.optional(),
    lifecycle: MetadataLifecycleSchema,
  })
  .strict();

export type SessionMetadata = z.infer<typeof CurrentSessionMetadataSchema>;

type LegacySessionMetadata = z.output<typeof LegacySessionMetadataSchema>;

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Partial<T>;
}

function optionalObject<T extends Record<string, unknown>>(
  value: Partial<T>
): Partial<T> | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function looksLikeCurrentMetadata(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'metadataSchemaVersion' in raw &&
    (raw as { metadataSchemaVersion?: unknown }).metadataSchemaVersion === 2
  );
}

function profileFromLegacy(metadata: LegacySessionMetadata): SessionMetadata['profile'] {
  if (metadata.profile) {
    return metadata.profile;
  }

  return optionalObject(
    omitUndefined({
      envVars: metadata.envVars,
      encryptedSecrets: metadata.encryptedSecrets,
      setupCommands: metadata.setupCommands,
      mcpServers: metadata.mcpServers,
      runtimeSkills: metadata.runtimeSkills,
      runtimeAgents: metadata.runtimeAgents,
    })
  ) as SessionMetadata['profile'];
}

function repositoryFromLegacy(
  metadata: LegacySessionMetadata
): SessionMetadata['repository'] | undefined {
  if (metadata.githubRepo) {
    return {
      type: 'github',
      repo: metadata.githubRepo,
      ...omitUndefined({
        platform: metadata.platform === 'github' ? 'github' : undefined,
        githubInstallationId: metadata.githubInstallationId,
        githubAppType: metadata.githubAppType,
        upstreamBranch: metadata.upstreamBranch,
      }),
    };
  }

  if (metadata.gitUrl && metadata.platform === 'gitlab') {
    return {
      type: 'gitlab',
      url: metadata.gitUrl,
      platform: 'gitlab',
      ...omitUndefined({
        gitlabTokenManaged: metadata.gitlabTokenManaged,
        upstreamBranch: metadata.upstreamBranch,
      }),
    };
  }

  if (metadata.gitUrl) {
    return {
      type: 'git',
      url: metadata.gitUrl,
      ...omitUndefined({
        token: metadata.gitToken,
        platform: metadata.platform,
        upstreamBranch: metadata.upstreamBranch,
      }),
    };
  }

  return undefined;
}

function legacyToCurrentSessionMetadata(metadata: LegacySessionMetadata): SessionMetadata {
  const current = {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: metadata.sessionId,
      userId: metadata.userId,
      ...omitUndefined({
        orgId: metadata.orgId,
        botId: metadata.botId,
        createdOnPlatform: metadata.createdOnPlatform,
      }),
    },
    auth: omitUndefined({
      kiloSessionId: metadata.kiloSessionId,
      kilocodeToken: metadata.kilocodeToken,
    }),
    repository: repositoryFromLegacy(metadata),
    initialMessage: optionalObject(
      omitUndefined({
        id: metadata.initialMessageId,
        prompt: metadata.prompt,
      })
    ),
    agent: optionalObject(
      omitUndefined({
        mode: metadata.mode,
        model: metadata.model,
        variant: metadata.variant,
        appendSystemPrompt: metadata.appendSystemPrompt,
      })
    ),
    finalization: optionalObject(
      omitUndefined({
        autoCommit: metadata.autoCommit,
        condenseOnComplete: metadata.condenseOnComplete,
        gateThreshold: metadata.gateThreshold,
      })
    ),
    profile: profileFromLegacy(metadata),
    callback: metadata.callbackTarget ? { target: metadata.callbackTarget } : undefined,
    workspace: optionalObject(
      omitUndefined({
        sandboxId: metadata.sandboxId,
        workspacePath: metadata.workspacePath,
        sessionHome: metadata.sessionHome,
        branchName: metadata.branchName,
        shallow: metadata.shallow,
      })
    ),
    devcontainer: metadata.devcontainer,
    lifecycle: {
      version: metadata.version,
      timestamp: metadata.timestamp,
      ...omitUndefined({
        preparedAt: metadata.preparedAt,
        initiatedAt: metadata.initiatedAt,
        kiloServerLastActivity: metadata.kiloServerLastActivity,
      }),
    },
  } satisfies SessionMetadata;

  return CurrentSessionMetadataSchema.parse(current);
}

export function parseSessionMetadata(raw: unknown): SessionMetadata {
  const current = CurrentSessionMetadataSchema.safeParse(raw);
  if (current.success) {
    return current.data;
  }

  if (looksLikeCurrentMetadata(raw)) {
    throw new Error(`Invalid current session metadata: ${JSON.stringify(current.error.format())}`);
  }

  return legacyToCurrentSessionMetadata(LegacySessionMetadataSchema.parse(raw));
}

export function serializeSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  return CurrentSessionMetadataSchema.parse(metadata);
}
