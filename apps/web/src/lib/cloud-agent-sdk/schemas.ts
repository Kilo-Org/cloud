import * as z from 'zod';
import { sortRemoteModelCatalogProviders } from './remote-model-order';

// ---------------------------------------------------------------------------
// Wire-level envelope
// ---------------------------------------------------------------------------

export const cloudAgentEventSchema = z.object({
  eventId: z.number(),
  executionId: z.string().nullable().optional(),
  sessionId: z.string(),
  streamEventType: z.string(),
  timestamp: z.string(),
  data: z.unknown(),
});
export type CloudAgentEvent = z.infer<typeof cloudAgentEventSchema>;

export const streamErrorSchema = z.object({
  type: z.literal('error'),
  code: z.enum([
    'WS_PROTOCOL_ERROR',
    'WS_AUTH_ERROR',
    'WS_SESSION_NOT_FOUND',
    'WS_EXECUTION_NOT_FOUND',
    'WS_DUPLICATE_CONNECTION',
    'WS_INTERNAL_ERROR',
  ]),
  message: z.string(),
});
export type StreamError = z.infer<typeof streamErrorSchema>;

// ---------------------------------------------------------------------------
// Session / cloud status discriminated unions
// ---------------------------------------------------------------------------

export const sessionStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('busy') }),
  z.object({ type: z.literal('idle') }),
  z.object({
    type: z.literal('retry'),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
  }),
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const cloudStatusSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('preparing'),
    step: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('ready') }),
  z.object({
    type: z.literal('finalizing'),
    step: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type CloudStatus = z.infer<typeof cloudStatusSchema>;

// ---------------------------------------------------------------------------
// Question / permission payloads
// ---------------------------------------------------------------------------

export const questionPayloadSchema = z
  .object({
    requestId: z.string(),
    callId: z.string().optional(),
    questions: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
export type QuestionState = z.infer<typeof questionPayloadSchema>;

export const permissionPayloadSchema = z
  .object({
    requestId: z.string(),
    callId: z.string().optional(),
    permission: z.string(),
    patterns: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    always: z.array(z.string()).optional().default([]),
  })
  .passthrough();
export type PermissionState = z.infer<typeof permissionPayloadSchema>;

// ---------------------------------------------------------------------------
// Remote CLI model catalog
// ---------------------------------------------------------------------------

export const REMOTE_MODEL_MAX_PROVIDERS = 64;
export const REMOTE_MODEL_MAX_MODELS_PER_PROVIDER = 512;
export const REMOTE_MODEL_MAX_MODELS_TOTAL = 2_048;
export const REMOTE_MODEL_MAX_VARIANTS_PER_MODEL = 32;
export const REMOTE_MODEL_MAX_VARIANTS_TOTAL = 8_192;
export const REMOTE_MODEL_IDENTITY_MAX_LENGTH = 255;
export const REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES = 512 * 1024;

const remoteModelIdentitySchema = z.string().min(1).max(REMOTE_MODEL_IDENTITY_MAX_LENGTH);
const remoteModelDisplayNameSchema = z.string().max(REMOTE_MODEL_IDENTITY_MAX_LENGTH);

export const modelRefSchema = z
  .object({
    providerID: remoteModelIdentitySchema,
    modelID: remoteModelIdentitySchema,
  })
  .strict();
export type ModelRef = z.infer<typeof modelRefSchema>;

export const modelSelectionSchema = z
  .object({
    model: modelRefSchema,
    variant: remoteModelIdentitySchema.optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

const emptyRemoteModelRecordSchema = z.object({}).strict();
const remoteModelModalitiesSchema = z
  .object({
    text: z.boolean(),
    audio: z.boolean(),
    image: z.boolean(),
    video: z.boolean(),
    pdf: z.boolean(),
  })
  .strict();
const remoteSdkModelSchema = z
  .object({
    id: remoteModelIdentitySchema,
    providerID: remoteModelIdentitySchema,
    api: z
      .object({
        id: remoteModelIdentitySchema,
        url: z.literal(''),
        npm: z.literal(''),
      })
      .strict(),
    name: remoteModelDisplayNameSchema,
    capabilities: z
      .object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: remoteModelModalitiesSchema,
        output: remoteModelModalitiesSchema,
        interleaved: z.union([
          z.boolean(),
          z.object({ field: z.enum(['reasoning_content', 'reasoning_details']) }).strict(),
        ]),
      })
      .strict(),
    cost: z
      .object({
        input: z.literal(0),
        output: z.literal(0),
        cache: z.object({ read: z.literal(0), write: z.literal(0) }).strict(),
      })
      .strict(),
    limit: z
      .object({
        context: z.number().finite().nonnegative(),
        input: z.number().finite().nonnegative().optional(),
        output: z.number().finite().nonnegative(),
      })
      .strict(),
    status: z.enum(['alpha', 'beta', 'deprecated', 'active']),
    options: emptyRemoteModelRecordSchema,
    headers: emptyRemoteModelRecordSchema,
    release_date: z.literal(''),
    recommendedIndex: z.number().finite().optional(),
    isFree: z.boolean().optional(),
    mayTrainOnYourPrompts: z.boolean().optional(),
    hasUserByokAvailable: z.boolean().optional(),
    variants: z.record(remoteModelIdentitySchema, emptyRemoteModelRecordSchema).optional(),
  })
  .strict();
const remoteSdkProviderSchema = z
  .object({
    id: remoteModelIdentitySchema,
    name: remoteModelDisplayNameSchema,
    source: z.enum(['env', 'config', 'custom', 'api']),
    env: z.array(z.never()).max(0),
    options: emptyRemoteModelRecordSchema,
    models: z.record(remoteModelIdentitySchema, remoteSdkModelSchema),
  })
  .strict();

export const remoteModelCatalogWireV1Schema = z
  .object({
    all: z.array(remoteSdkProviderSchema).max(REMOTE_MODEL_MAX_PROVIDERS),
    default: z.record(remoteModelIdentitySchema, remoteModelIdentitySchema),
    connected: z.array(remoteModelIdentitySchema).max(REMOTE_MODEL_MAX_PROVIDERS),
    failed: z.array(remoteModelIdentitySchema).max(REMOTE_MODEL_MAX_PROVIDERS),
    protocolVersion: z.literal(1),
    currentModel: modelSelectionSchema.optional(),
    defaultModel: modelRefSchema.optional(),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((catalog, context) => {
    let modelCount = 0;
    let variantCount = 0;
    const providers = new Map(catalog.all.map(provider => [provider.id, provider]));
    if (providers.size !== catalog.all.length) {
      context.addIssue({ code: 'custom', message: 'Provider ID must be unique', path: ['all'] });
    }
    if (new Set(catalog.connected).size !== catalog.connected.length) {
      context.addIssue({
        code: 'custom',
        message: 'Connected provider ID must be unique',
        path: ['connected'],
      });
    }
    for (const [providerIndex, provider] of catalog.all.entries()) {
      const models = Object.entries(provider.models);
      modelCount += models.length;
      if (models.length > REMOTE_MODEL_MAX_MODELS_PER_PROVIDER) {
        context.addIssue({
          code: 'custom',
          message: `Provider cannot contain more than ${REMOTE_MODEL_MAX_MODELS_PER_PROVIDER} models`,
          path: ['all', providerIndex, 'models'],
        });
      }
      for (const [modelKey, model] of models) {
        if (
          modelKey !== model.id ||
          model.providerID !== provider.id ||
          model.api.id !== model.id
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Model record identity must match its provider and record key',
            path: ['all', providerIndex, 'models', modelKey],
          });
        }
        const variants = Object.keys(model.variants ?? {});
        variantCount += variants.length;
        if (variants.length > REMOTE_MODEL_MAX_VARIANTS_PER_MODEL) {
          context.addIssue({
            code: 'custom',
            message: `Model cannot contain more than ${REMOTE_MODEL_MAX_VARIANTS_PER_MODEL} variants`,
            path: ['all', providerIndex, 'models', modelKey, 'variants'],
          });
        }
      }
    }
    for (const providerId of catalog.connected) {
      if (!providers.has(providerId)) {
        context.addIssue({
          code: 'custom',
          message: 'Connected provider must exist in all',
          path: ['connected'],
        });
      }
    }
    for (const [providerId, modelId] of Object.entries(catalog.default)) {
      const provider = providers.get(providerId);
      if (!provider || !Object.hasOwn(provider.models, modelId)) {
        context.addIssue({
          code: 'custom',
          message: 'Default model must exist in all',
          path: ['default', providerId],
        });
      }
    }
    if (modelCount > REMOTE_MODEL_MAX_MODELS_TOTAL) {
      context.addIssue({
        code: 'custom',
        message: `Catalog cannot contain more than ${REMOTE_MODEL_MAX_MODELS_TOTAL} models`,
        path: ['all'],
      });
    }
    if (variantCount > REMOTE_MODEL_MAX_VARIANTS_TOTAL) {
      context.addIssue({
        code: 'custom',
        message: `Catalog cannot contain more than ${REMOTE_MODEL_MAX_VARIANTS_TOTAL} variants`,
        path: ['all'],
      });
    }
    const serializedBytes = new TextEncoder().encode(JSON.stringify(catalog)).byteLength;
    if (serializedBytes > REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `Catalog cannot exceed ${REMOTE_MODEL_CATALOG_MAX_SERIALIZED_BYTES} serialized bytes`,
      });
    }
  });
export type RemoteModelCatalogWireV1 = z.input<typeof remoteModelCatalogWireV1Schema>;

export const remoteModelCatalogV1Schema = remoteModelCatalogWireV1Schema.transform(catalog => {
  const connected = new Set(catalog.connected);
  return {
    protocolVersion: 1 as const,
    providers: sortRemoteModelCatalogProviders(
      catalog.all
        .filter(provider => connected.has(provider.id))
        .map(provider => ({
          id: provider.id,
          ...(provider.name ? { name: provider.name } : {}),
          models: Object.values(provider.models).map(model => ({
            id: model.id,
            ...(model.name ? { name: model.name } : {}),
            ...(model.recommendedIndex !== undefined
              ? { recommendedIndex: model.recommendedIndex }
              : {}),
            ...(model.isFree !== undefined ? { isFree: model.isFree } : {}),
            ...(model.mayTrainOnYourPrompts !== undefined
              ? { mayTrainOnYourPrompts: model.mayTrainOnYourPrompts }
              : {}),
            ...(model.hasUserByokAvailable !== undefined
              ? { hasUserByokAvailable: model.hasUserByokAvailable }
              : {}),
            variants: Object.keys(model.variants ?? {}),
            capabilities: {
              attachment: model.capabilities.attachment,
              reasoning: model.capabilities.reasoning,
            },
            limits: {
              context: model.limit.context,
              output: model.limit.output,
            },
          })),
        }))
    ),
    ...(catalog.currentModel ? { currentModel: catalog.currentModel } : {}),
    ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel } : {}),
    truncated: catalog.truncated,
  };
});
export type RemoteModelCatalogV1 = z.output<typeof remoteModelCatalogV1Schema>;

export const userWebCommandErrorDataSchema = z
  .object({
    source: z.literal('relay'),
    code: z.string(),
    message: z.string(),
  })
  .strict();
export type UserWebCommandErrorData = z.infer<typeof userWebCommandErrorDataSchema>;

// ---------------------------------------------------------------------------
// WebSocket inbound message (CLI live transport)
// ---------------------------------------------------------------------------

export const webInboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    parentSessionId: z.string().optional(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({ type: z.literal('system'), event: z.string(), data: z.unknown() }),
  z.object({ type: z.literal('pong'), nonce: z.string() }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
]);
export type WebInboundMessage = z.infer<typeof webInboundMessageSchema>;

// ---------------------------------------------------------------------------
// Active CLI sessions
// ---------------------------------------------------------------------------

export const activeSessionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    title: z.string(),
    gitUrl: z.string().optional(),
    gitBranch: z.string().optional(),
    parentSessionId: z.string().optional(),
  })
  .passthrough();
export type ActiveSessionData = z.infer<typeof activeSessionSchema>;

export const activeSessionWithConnectionSchema = activeSessionSchema.extend({
  connectionId: z.string(),
});
export type ActiveSessionWithConnectionData = z.infer<typeof activeSessionWithConnectionSchema>;

export const sessionsListDataSchema = z.object({
  sessions: z.array(activeSessionWithConnectionSchema),
});
export type SessionsListData = z.infer<typeof sessionsListDataSchema>;

export const heartbeatDataSchema = z.object({
  connectionId: z.string(),
  sessions: z.array(activeSessionSchema),
});
export type HeartbeatData = z.infer<typeof heartbeatDataSchema>;

export const cliConnectionDataSchema = z.object({
  connectionId: z.string(),
});
export type CliConnectionData = z.infer<typeof cliConnectionDataSchema>;

// ---------------------------------------------------------------------------
// V2 session system events
// ---------------------------------------------------------------------------

export const sessionStatusValueSchema = z.enum(['idle', 'busy', 'question', 'permission', 'retry']);

export const sessionEventV2RowSchema = z.object({
  source: z.literal('v2'),
  sessionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string().nullable(),
  createdOnPlatform: z.string().nullable(),
  organizationId: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  status: sessionStatusValueSchema.nullable(),
  statusUpdatedAt: z.string().nullable(),
});
export type SessionEventV2Row = z.infer<typeof sessionEventV2RowSchema>;

export const sessionRowEventPayloadSchema = z.object({
  source: z.literal('v2'),
  session: sessionEventV2RowSchema,
  changedAt: z.string(),
});
export type SessionRowEventPayload = z.infer<typeof sessionRowEventPayloadSchema>;

export const sessionStatusUpdatedPayloadSchema = z.union([
  z.object({
    source: z.literal('v2'),
    session: sessionEventV2RowSchema,
    previousStatus: sessionStatusValueSchema.nullable(),
    status: sessionStatusValueSchema.nullable(),
    statusUpdatedAt: z.string().nullable(),
    changedAt: z.string(),
  }),
  z.object({
    source: z.literal('v2'),
    sessionId: z.string(),
    previousStatus: sessionStatusValueSchema.nullable(),
    status: sessionStatusValueSchema.nullable(),
    statusUpdatedAt: z.string().nullable(),
    updatedAt: z.string().optional(),
    changedAt: z.string(),
  }),
]);
export type SessionStatusUpdatedPayload = z.infer<typeof sessionStatusUpdatedPayloadSchema>;

export const sessionDeletedPayloadSchema = z.object({
  source: z.literal('v2'),
  sessionId: z.string(),
  parentSessionId: z.string().nullable(),
  organizationId: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  createdOnPlatform: z.string().nullable(),
  deletedAt: z.string(),
});
export type SessionDeletedPayload = z.infer<typeof sessionDeletedPayloadSchema>;

export const sessionEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.created'), data: sessionRowEventPayloadSchema }),
  z.object({ type: z.literal('session.updated'), data: sessionRowEventPayloadSchema }),
  z.object({ type: z.literal('session.status.updated'), data: sessionStatusUpdatedPayloadSchema }),
  z.object({ type: z.literal('session.deleted'), data: sessionDeletedPayloadSchema }),
]);
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;

// ---------------------------------------------------------------------------
// Kilocode payload
// ---------------------------------------------------------------------------

export const kilocodePayloadSchema = z.object({
  type: z.string(),
  properties: z.unknown(),
});
export type KilocodePayload = z.infer<typeof kilocodePayloadSchema>;

// ---------------------------------------------------------------------------
// Per-event-type data schemas (normalizeInnerEvent)
// ---------------------------------------------------------------------------

export const messageUpdatedDataSchema = z.object({
  info: z.object({ id: z.string(), sessionID: z.string() }).passthrough(),
});
export type MessageUpdatedData = z.infer<typeof messageUpdatedDataSchema>;

export const messagePartUpdatedDataSchema = z.object({
  part: z.object({ id: z.string(), sessionID: z.string(), messageID: z.string() }).passthrough(),
});
export type MessagePartUpdatedData = z.infer<typeof messagePartUpdatedDataSchema>;

export const messagePartDeltaDataSchema = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  partID: z.string(),
  field: z.string(),
  delta: z.string(),
});
export type MessagePartDeltaData = z.infer<typeof messagePartDeltaDataSchema>;

export const messagePartRemovedDataSchema = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  partID: z.string(),
});
export type MessagePartRemovedData = z.infer<typeof messagePartRemovedDataSchema>;

export const sessionStatusDataSchema = z.object({
  sessionID: z.string(),
  status: sessionStatusSchema,
});
export type SessionStatusData = z.infer<typeof sessionStatusDataSchema>;

export const sessionCreatedDataSchema = z.object({
  info: z.object({ id: z.string() }).passthrough(),
});
export type SessionCreatedData = z.infer<typeof sessionCreatedDataSchema>;

export const sessionUpdatedDataSchema = z.object({
  info: z.object({ id: z.string() }).passthrough(),
});
export type SessionUpdatedData = z.infer<typeof sessionUpdatedDataSchema>;

export const sessionErrorDataSchema = z
  .object({
    error: z.unknown().optional(),
    sessionID: z.unknown().optional(),
  })
  .passthrough();
export type SessionErrorData = z.infer<typeof sessionErrorDataSchema>;

export const sessionIdleDataSchema = z
  .object({
    sessionID: z.unknown(),
  })
  .passthrough();
export type SessionIdleData = z.infer<typeof sessionIdleDataSchema>;

export const sessionTurnCloseDataSchema = z
  .object({
    sessionID: z.string().optional().catch(undefined),
    reason: z.string().optional().catch(undefined),
  })
  .passthrough();
export type SessionTurnCloseData = z.infer<typeof sessionTurnCloseDataSchema>;

export const questionAskedDataSchema = z.object({
  id: z.string(),
  tool: z.object({ callID: z.string() }).optional(),
  questions: z.array(z.unknown()).optional().catch(undefined),
});
export type QuestionAskedData = z.infer<typeof questionAskedDataSchema>;

export const questionRepliedDataSchema = z.object({
  requestID: z.string(),
});
export type QuestionRepliedData = z.infer<typeof questionRepliedDataSchema>;

export const questionRejectedDataSchema = z.object({
  requestID: z.string(),
});
export type QuestionRejectedData = z.infer<typeof questionRejectedDataSchema>;

export const permissionAskedDataSchema = z.object({
  id: z.string().min(1),
  permission: z.string(),
  tool: z.object({ callID: z.string() }).optional(),
  patterns: z.array(z.string()).catch([]),
  metadata: z.record(z.string(), z.unknown()).catch({}),
  always: z.array(z.string()).catch([]),
});
export type PermissionAskedData = z.infer<typeof permissionAskedDataSchema>;

export const permissionRepliedDataSchema = z.object({
  requestID: z.string(),
});
export type PermissionRepliedData = z.infer<typeof permissionRepliedDataSchema>;

// `suggest` tool payloads — requires Kilo CLI >= v7.2.7 (recommended >= v7.2.14).
// Older CLIs never emit these events, so no explicit version gate is needed here.

export const suggestionActionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
});
export type SuggestionActionData = z.infer<typeof suggestionActionSchema>;

export const suggestionShownDataSchema = z.object({
  id: z.string(),
  sessionID: z.string().optional(),
  text: z.string(),
  actions: z.array(suggestionActionSchema).catch([]),
  tool: z.object({ messageID: z.string(), callID: z.string() }).optional(),
});
export type SuggestionShownData = z.infer<typeof suggestionShownDataSchema>;

export const suggestionAcceptedDataSchema = z.object({
  requestID: z.string(),
  index: z.number(),
  action: suggestionActionSchema.optional(),
});
export type SuggestionAcceptedData = z.infer<typeof suggestionAcceptedDataSchema>;

export const suggestionDismissedDataSchema = z.object({
  requestID: z.string(),
});
export type SuggestionDismissedData = z.infer<typeof suggestionDismissedDataSchema>;

export const completeDataSchema = z
  .object({
    currentBranch: z.string().optional().catch(undefined),
  })
  .passthrough();
export type CompleteData = z.infer<typeof completeDataSchema>;

export const interruptedDataSchema = z.unknown();
export type InterruptedData = z.infer<typeof interruptedDataSchema>;

export const errorDataSchema = z
  .object({
    fatal: z.boolean().optional(),
  })
  .passthrough();
export type ErrorData = z.infer<typeof errorDataSchema>;

export const wrapperDisconnectedDataSchema = z.unknown();
export type WrapperDisconnectedData = z.infer<typeof wrapperDisconnectedDataSchema>;

const preparationStepSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(['phase', 'setup_command']),
  label: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  revision: z.number(),
  latestDetail: z.string().optional(),
  safeError: z.string().optional(),
  command: z.string().optional(),
  commandIndex: z.number().optional(),
  commandCount: z.number().optional(),
  outputTail: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  exitCode: z.number().optional(),
});

const preparationAttemptSchema = z.object({
  id: z.string(),
  triggerMessageId: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  safeError: z.string().optional(),
  revision: z.number(),
});

export const preparingDataSchema = z
  .object({
    step: z.string(),
    message: z.string(),
    branch: z.string().optional(),
    version: z.literal(2).optional(),
    attemptId: z.string().optional(),
    triggerMessageId: z.string().optional(),
    revision: z.number().optional(),
    timestamp: z.number().optional(),
    action: z
      .enum([
        'attempt_started',
        'step_started',
        'step_progress',
        'step_output',
        'step_completed',
        'step_failed',
        'attempt_completed',
        'attempt_failed',
        'attempt_snapshot',
        'step_snapshot',
      ])
      .optional(),
    stepId: z.string().optional(),
    kind: z.enum(['phase', 'setup_command']).optional(),
    label: z.string().optional(),
    command: z.string().optional(),
    commandIndex: z.number().optional(),
    commandCount: z.number().optional(),
    detail: z.string().optional(),
    output: z.string().optional(),
    safeError: z.string().optional(),
    exitCode: z.number().optional(),
    attempt: preparationAttemptSchema.optional(),
    stepSnapshot: preparationStepSchema.optional(),
  })
  .passthrough();
export type PreparingData = z.infer<typeof preparingDataSchema>;

export const autocommitStartedDataSchema = z.object({
  messageId: z.string(),
  message: z.string().optional(),
});
export type AutocommitStartedData = z.infer<typeof autocommitStartedDataSchema>;

export const autocommitCompletedDataSchema = z.object({
  messageId: z.string(),
  success: z.boolean().catch(false),
  message: z.string().optional(),
  skipped: z.boolean().optional(),
  commitHash: z.string().optional(),
  commitMessage: z.string().optional(),
});
export type AutocommitCompletedData = z.infer<typeof autocommitCompletedDataSchema>;

export const cloudStatusDataSchema = z.object({
  cloudStatus: cloudStatusSchema,
});
export type CloudStatusData = z.infer<typeof cloudStatusDataSchema>;

export const connectedDataSchema = z.object({
  sessionStatus: sessionStatusSchema.optional().catch(undefined),
  cloudStatus: cloudStatusSchema.optional().catch(undefined),
});
export type ConnectedData = z.infer<typeof connectedDataSchema>;

/**
 * Slash command catalog item — the trimmed `Command.Info` we get over the wire.
 * The wrapper strips `template` server-side because kilo handles substitution.
 */
export const slashCommandInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  source: z.enum(['command', 'mcp', 'skill']).optional(),
  hints: z.array(z.string()).default([]),
  subtask: z.boolean().optional(),
});
export type SlashCommandInfo = z.infer<typeof slashCommandInfoSchema>;

export const commandsAvailableDataSchema = z.object({
  commands: z.array(slashCommandInfoSchema),
});
export type CommandsAvailableData = z.infer<typeof commandsAvailableDataSchema>;

// ---------------------------------------------------------------------------
// Per-message delivery lifecycle (cloud.message.*)
// ---------------------------------------------------------------------------

export const cloudMessageQueuedDataSchema = z.object({
  messageId: z.string(),
  executionId: z.string().optional(),
  content: z.string().optional(),
  delivery: z.literal('queued').optional(),
});
export type CloudMessageQueuedData = z.infer<typeof cloudMessageQueuedDataSchema>;

export const cloudMessageSentDataSchema = z
  .object({
    messageId: z.string(),
    executionId: z.string().optional(),
    delivery: z.literal('sent').optional(),
  })
  .passthrough();
export type CloudMessageSentData = z.infer<typeof cloudMessageSentDataSchema>;

export const cloudMessageCompletedDataSchema = z
  .object({
    messageId: z.string(),
    executionId: z.string().optional(),
  })
  .passthrough();
export type CloudMessageCompletedData = z.infer<typeof cloudMessageCompletedDataSchema>;

export const cloudMessageFailedDataSchema = z
  .object({
    messageId: z.string(),
    executionId: z.string().optional(),
    error: z.unknown().optional(),
    reason: z.string().optional(),
    delivery: z.enum(['queued', 'sent']).optional(),
    attempts: z.number().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type CloudMessageFailedData = z.infer<typeof cloudMessageFailedDataSchema>;

// ---------------------------------------------------------------------------
// Session snapshot (historical transport / replay)
// ---------------------------------------------------------------------------

export const sessionSnapshotSchema = z.object({
  info: z.object({ id: z.unknown() }).passthrough(),
  messages: z.array(
    z.object({
      info: z.object({ id: z.string() }).passthrough(),
      parts: z.array(z.object({ id: z.string() }).passthrough()),
    })
  ),
});
export type SessionSnapshotData = z.infer<typeof sessionSnapshotSchema>;

// ---------------------------------------------------------------------------
// Error shape (session-manager tRPC error extraction)
// ---------------------------------------------------------------------------

export const errorShapeSchema = z
  .object({
    message: z.string().optional(),
    data: z
      .object({
        code: z.string().optional(),
        httpStatus: z.number().optional(),
      })
      .passthrough()
      .optional(),
    shape: z
      .object({
        code: z.string().optional(),
        data: z
          .object({
            httpStatus: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ErrorShape = z.infer<typeof errorShapeSchema>;
