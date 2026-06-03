import { z } from 'zod';

export const sessionIdSchema = z.string().startsWith('ses_').length(30);
export const messageIdSchema = z
  .string()
  .startsWith('msg')
  .refine(id => !id.includes('/') && !id.includes('\u0000'), {
    message: 'message IDs must not contain / or U+0000',
  });
export const partIdSchema = z
  .string()
  .startsWith('prt')
  .refine(id => !id.includes('/') && !id.includes('\u0000'), {
    message: 'part IDs must not contain / or U+0000',
  });
const sdkMetadataSchema = z.record(z.string(), z.unknown());

export const createSessionForCloudAgentSchema = z.object({
  sessionId: sessionIdSchema,
  kiloUserId: z.string().min(1),
  cloudAgentSessionId: z.string().min(1),
  organizationId: z.string().optional(),
  createdOnPlatform: z.string().min(1),
  title: z.string().optional(),
});
export type CreateSessionForCloudAgentParams = z.input<typeof createSessionForCloudAgentSchema>;

export const deleteSessionForCloudAgentSchema = z.object({
  sessionId: sessionIdSchema,
  kiloUserId: z.string().min(1),
  onlyIfEmpty: z.boolean().optional(),
});
export type DeleteSessionForCloudAgentParams = z.input<typeof deleteSessionForCloudAgentSchema>;

export const resolveCloudAgentRootSessionSchema = z.object({
  kiloUserId: z.string().min(1),
  kiloSessionId: sessionIdSchema,
});
export type ResolveCloudAgentRootSessionForKiloSessionParams = z.input<
  typeof resolveCloudAgentRootSessionSchema
>;
export type ResolveCloudAgentRootSessionForKiloSessionResult = {
  cloudAgentSessionId: string;
} | null;

export const kiloSdkSessionInfoSchema = z.object({
  id: sessionIdSchema,
  slug: z.string(),
  projectID: z.string(),
  workspaceID: z.string().optional(),
  directory: z.string(),
  path: z.string().optional(),
  parentID: z.string().optional(),
  summary: z
    .object({
      additions: z.number(),
      deletions: z.number(),
      files: z.number(),
      diffs: z
        .array(
          z.object({
            file: z.string(),
            additions: z.number(),
            deletions: z.number(),
            status: z.enum(['added', 'deleted', 'modified']).optional(),
          })
        )
        .optional(),
    })
    .optional(),
  share: z.object({ url: z.string() }).optional(),
  title: z.string(),
  agent: z.string().optional(),
  model: z
    .object({
      id: z.string(),
      providerID: z.string(),
      variant: z.string().optional(),
    })
    .optional(),
  version: z.string(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    compacting: z.number().optional(),
    archived: z.number().optional(),
  }),
  permission: z
    .array(
      z.object({
        permission: z.string(),
        pattern: z.string(),
        action: z.enum(['allow', 'deny', 'ask']),
      })
    )
    .optional(),
  revert: z
    .object({
      messageID: z.string(),
      partID: z.string().optional(),
      snapshot: z.string().optional(),
      diff: z.string().optional(),
    })
    .optional(),
});
export type KiloSdkSessionInfo = z.infer<typeof kiloSdkSessionInfoSchema>;

export const kiloSdkSessionSnapshotOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({
    kind: z.literal('value'),
    info: kiloSdkSessionInfoSchema,
    byteLength: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('too_large'), maximumBytes: z.number().int().positive() }),
  z.object({ kind: z.literal('retryable_failure') }),
  z.object({ kind: z.literal('invalid_data') }),
]);
export type KiloSdkSessionSnapshotRead = z.infer<typeof kiloSdkSessionSnapshotOutcomeSchema>;
export type KiloSdkSessionSnapshotOutcome = KiloSdkSessionSnapshotRead;

export type CloudAgentRootSessionSnapshot = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
  snapshot: KiloSdkSessionSnapshotRead;
};
export type GetCloudAgentRootSessionSnapshotParams =
  ResolveCloudAgentRootSessionForKiloSessionParams;
export type GetCloudAgentRootSessionSnapshotResult = CloudAgentRootSessionSnapshot | null;

export const MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE = 100;

export const listCloudAgentRootSessionsSchema = z.object({
  kiloUserId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional().default(100),
  start: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
});
export type ListCloudAgentRootSessionsParams = z.input<typeof listCloudAgentRootSessionsSchema>;
export type CloudAgentRootSessionSummary = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
  title: string | null;
  created: number;
  updated: number;
};

export const sdkApiErrorSchema = z.object({
  name: z.literal('APIError'),
  data: z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
});
export type KiloSdkApiError = z.infer<typeof sdkApiErrorSchema>;

export const sdkAssistantErrorSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('ProviderAuthError'),
    data: z.object({ providerID: z.string(), message: z.string() }),
  }),
  z.object({ name: z.literal('UnknownError'), data: z.object({ message: z.string() }) }),
  z.object({ name: z.literal('MessageOutputLengthError'), data: sdkMetadataSchema }),
  z.object({ name: z.literal('MessageAbortedError'), data: z.object({ message: z.string() }) }),
  z.object({
    name: z.literal('StructuredOutputError'),
    data: z.object({ message: z.string(), retries: z.number() }),
  }),
  z.object({
    name: z.literal('ContextOverflowError'),
    data: z.object({ message: z.string(), responseBody: z.string().optional() }),
  }),
  sdkApiErrorSchema,
]);
export type KiloSdkAssistantError = z.infer<typeof sdkAssistantErrorSchema>;

const sdkSnapshotFileDiffBaseSchema = z.object({
  file: z.string(),
  additions: z.number(),
  deletions: z.number(),
  status: z.enum(['added', 'deleted', 'modified']).optional(),
});
export const sdkSnapshotFileDiffSchema = sdkSnapshotFileDiffBaseSchema
  .extend({ patch: z.string() })
  .strict();
const historicalSnapshotFileDiffSchema = sdkSnapshotFileDiffBaseSchema
  .extend({
    before: z.string(),
    after: z.string(),
  })
  .strict();
export const persistedSnapshotFileDiffsSchema = z
  .array(z.union([sdkSnapshotFileDiffSchema, historicalSnapshotFileDiffSchema]))
  .transform(diffs => diffs.filter(diff => 'patch' in diff));

const kiloSdkUserMessageBaseShape = {
  id: messageIdSchema,
  sessionID: sessionIdSchema,
  role: z.literal('user'),
  time: z.object({ created: z.number() }),
  format: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('text') }),
      z.object({
        type: z.literal('json_schema'),
        schema: sdkMetadataSchema,
        retryCount: z.number().optional(),
      }),
    ])
    .optional(),
  agent: z.string(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
    variant: z.string().optional(),
  }),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  editorContext: z
    .object({
      visibleFiles: z.array(z.string()).optional(),
      openTabs: z.array(z.string()).optional(),
      activeFile: z.string().optional(),
      shell: z.string().optional(),
    })
    .optional(),
};
const sdkUserMessageSummaryBaseShape = {
  title: z.string().optional(),
  body: z.string().optional(),
};
export const kiloSdkUserMessageSchema = z.object({
  ...kiloSdkUserMessageBaseShape,
  summary: z
    .object({
      ...sdkUserMessageSummaryBaseShape,
      diffs: z.array(sdkSnapshotFileDiffSchema),
    })
    .optional(),
});
export type KiloSdkUserMessage = z.infer<typeof kiloSdkUserMessageSchema>;

export const kiloSdkAssistantMessageSchema = z.object({
  id: messageIdSchema,
  sessionID: sessionIdSchema,
  role: z.literal('assistant'),
  time: z.object({ created: z.number(), completed: z.number().optional() }),
  error: sdkAssistantErrorSchema.optional(),
  parentID: messageIdSchema,
  modelID: z.string(),
  providerID: z.string(),
  mode: z.string(),
  agent: z.string(),
  path: z.object({ cwd: z.string(), root: z.string() }),
  summary: z.boolean().optional(),
  cost: z.number(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
  structured: z.unknown().optional(),
  variant: z.string().optional(),
  finish: z.string().optional(),
});
export type KiloSdkAssistantMessage = z.infer<typeof kiloSdkAssistantMessageSchema>;

export const kiloSdkMessageSchema = z.discriminatedUnion('role', [
  kiloSdkUserMessageSchema,
  kiloSdkAssistantMessageSchema,
]);
export type KiloSdkMessageInfo = z.infer<typeof kiloSdkMessageSchema>;

const sdkPartBaseShape = {
  id: partIdSchema,
  sessionID: sessionIdSchema,
  messageID: messageIdSchema,
};
const sdkPartBaseSchema = z.object(sdkPartBaseShape);
export type KiloSdkPartBase = z.infer<typeof sdkPartBaseSchema>;

export const sdkFilePartSchema = z.object({
  ...sdkPartBaseShape,
  type: z.literal('file'),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  source: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('file'),
        text: z.object({ value: z.string(), start: z.number(), end: z.number() }),
        path: z.string(),
      }),
      z.object({
        type: z.literal('symbol'),
        text: z.object({ value: z.string(), start: z.number(), end: z.number() }),
        path: z.string(),
        range: z.object({
          start: z.object({ line: z.number(), character: z.number() }),
          end: z.object({ line: z.number(), character: z.number() }),
        }),
        name: z.string(),
        kind: z.number(),
      }),
      z.object({
        type: z.literal('resource'),
        text: z.object({ value: z.string(), start: z.number(), end: z.number() }),
        clientName: z.string(),
        uri: z.string(),
      }),
    ])
    .optional(),
});
export type KiloSdkFilePart = z.infer<typeof sdkFilePartSchema>;

export const sdkToolStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), input: sdkMetadataSchema, raw: z.string() }),
  z.object({
    status: z.literal('running'),
    input: sdkMetadataSchema,
    title: z.string().optional(),
    metadata: sdkMetadataSchema.optional(),
    time: z.object({ start: z.number() }),
  }),
  z.object({
    status: z.literal('completed'),
    input: sdkMetadataSchema,
    output: z.string(),
    title: z.string(),
    metadata: sdkMetadataSchema,
    time: z.object({ start: z.number(), end: z.number(), compacted: z.number().optional() }),
    attachments: z.array(sdkFilePartSchema).optional(),
  }),
  z.object({
    status: z.literal('error'),
    input: sdkMetadataSchema,
    error: z.string(),
    metadata: sdkMetadataSchema.optional(),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
]);
export type KiloSdkToolState = z.infer<typeof sdkToolStateSchema>;

export const kiloSdkPartSchema = z.discriminatedUnion('type', [
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('text'),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
    metadata: sdkMetadataSchema.optional(),
  }),
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('subtask'),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
    command: z.string().optional(),
  }),
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('reasoning'),
    text: z.string(),
    metadata: sdkMetadataSchema.optional(),
    time: z.object({ start: z.number(), end: z.number().optional() }),
  }),
  sdkFilePartSchema,
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('tool'),
    callID: z.string(),
    tool: z.string(),
    state: sdkToolStateSchema,
    metadata: sdkMetadataSchema.optional(),
  }),
  z.object({ ...sdkPartBaseShape, type: z.literal('step-start'), snapshot: z.string().optional() }),
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('step-finish'),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({ read: z.number(), write: z.number() }),
    }),
  }),
  z.object({ ...sdkPartBaseShape, type: z.literal('snapshot'), snapshot: z.string() }),
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('patch'),
    hash: z.string(),
    files: z.array(z.string()),
  }),
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('agent'),
    name: z.string(),
    source: z.object({ value: z.string(), start: z.number(), end: z.number() }).optional(),
  }),
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('retry'),
    attempt: z.number(),
    error: sdkApiErrorSchema,
    time: z.object({ created: z.number() }),
  }),
  z.object({
    ...sdkPartBaseShape,
    type: z.literal('compaction'),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    tail_start_id: messageIdSchema.optional(),
  }),
]);
export type KiloSdkPart = z.infer<typeof kiloSdkPartSchema>;

export const kiloSdkStoredMessageSchema = z.object({
  info: kiloSdkMessageSchema,
  parts: z.array(kiloSdkPartSchema),
});
export type KiloSdkStoredMessage = z.infer<typeof kiloSdkStoredMessageSchema>;

export const kiloSdkMessageHistoryPageSchema = z.object({
  messages: z.array(kiloSdkStoredMessageSchema),
  nextCursor: z.string().nullable(),
  omittedItemCount: z.number().int().nonnegative().default(0),
});
export type KiloSdkMessageHistoryPage = z.infer<typeof kiloSdkMessageHistoryPageSchema>;

export const kiloSdkHistoryTooLargeSchema = z.object({
  kind: z.literal('too_large'),
  maximumBytes: z.number().int().positive(),
  phase: z.enum(['message_scan', 'page_parts']),
});
export type KiloSdkHistoryTooLarge = z.infer<typeof kiloSdkHistoryTooLargeSchema>;

export const kiloSdkHistoryRetryableFailureSchema = z.object({
  kind: z.literal('retryable_failure'),
  phase: z.enum(['message_scan', 'page_parts']),
});
export type KiloSdkHistoryRetryableFailure = z.infer<typeof kiloSdkHistoryRetryableFailureSchema>;

export const kiloSdkInvalidDataSchema = z.object({ kind: z.literal('invalid_data') });
export type KiloSdkInvalidData = z.infer<typeof kiloSdkInvalidDataSchema>;

export const kiloSdkMessageHistorySchema = z.union([
  kiloSdkMessageHistoryPageSchema,
  kiloSdkHistoryTooLargeSchema,
  kiloSdkHistoryRetryableFailureSchema,
  kiloSdkInvalidDataSchema,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePersistedSnapshotFileDiffs(value: unknown): unknown {
  const parsed = persistedSnapshotFileDiffsSchema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

function isKnownKiloSdkPartType(type: string): boolean {
  return kiloSdkPartSchema.options.some(option => option.shape.type.safeParse(type).success);
}

type NormalizedPersistedStoredMessage = {
  message: unknown;
  omittedItemCount: number;
};

function normalizePersistedKiloSdkParts(value: unknown): {
  parts: unknown;
  omittedItemCount: number;
} {
  if (!Array.isArray(value)) {
    return { parts: value, omittedItemCount: 0 };
  }
  const parts: unknown[] = [];
  let omittedItemCount = 0;
  for (const part of value) {
    if (
      isRecord(part) &&
      typeof part.type === 'string' &&
      !isKnownKiloSdkPartType(part.type) &&
      sdkPartBaseSchema.safeParse(part).success
    ) {
      omittedItemCount += 1;
      continue;
    }
    parts.push(part);
  }
  return { parts, omittedItemCount };
}

function normalizePersistedKiloSdkStoredMessage(value: unknown): NormalizedPersistedStoredMessage {
  if (!isRecord(value)) {
    return { message: value, omittedItemCount: 0 };
  }
  const normalizedParts = normalizePersistedKiloSdkParts(value.parts);
  const message = { ...value, parts: normalizedParts.parts };
  if (!isRecord(value.info) || value.info.role !== 'user') {
    return { message, omittedItemCount: normalizedParts.omittedItemCount };
  }
  const summary = value.info.summary;
  if (!isRecord(summary) || !('diffs' in summary)) {
    return { message, omittedItemCount: normalizedParts.omittedItemCount };
  }
  return {
    message: {
      ...message,
      info: {
        ...value.info,
        summary: {
          ...summary,
          diffs: normalizePersistedSnapshotFileDiffs(summary.diffs),
        },
      },
    },
    omittedItemCount: normalizedParts.omittedItemCount,
  };
}

function normalizePersistedKiloSdkMessageHistory(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return value;
  }
  const normalizedMessages = value.messages.map(normalizePersistedKiloSdkStoredMessage);
  const additionalOmittedItemCount = normalizedMessages.reduce(
    (count, message) => count + message.omittedItemCount,
    0
  );
  const omittedItemCount = z.number().int().nonnegative().safeParse(value.omittedItemCount);
  return {
    ...value,
    messages: normalizedMessages.map(message => message.message),
    ...(additionalOmittedItemCount === 0
      ? {}
      : {
          omittedItemCount: omittedItemCount.success
            ? omittedItemCount.data + additionalOmittedItemCount
            : value.omittedItemCount === undefined
              ? additionalOmittedItemCount
              : value.omittedItemCount,
        }),
  };
}

export const persistedKiloSdkMessageHistorySchema = z.preprocess(
  normalizePersistedKiloSdkMessageHistory,
  kiloSdkMessageHistorySchema
);
export type KiloSdkMessageHistory = z.infer<typeof kiloSdkMessageHistorySchema>;

export const kiloSdkMessagesLegacyCursorSchema = z
  .object({
    id: messageIdSchema,
    time: z.number().nonnegative(),
  })
  .strict();
export type KiloSdkMessagesLegacyCursor = z.infer<typeof kiloSdkMessagesLegacyCursorSchema>;

export const kiloSdkMessagesCursorSchema = kiloSdkMessagesLegacyCursorSchema;
export type KiloSdkMessagesCursor = KiloSdkMessagesLegacyCursor;

export function encodeKiloSdkMessagesCursor(cursor: KiloSdkMessagesCursor): string {
  const parsed = kiloSdkMessagesCursorSchema.parse(cursor);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeKiloSdkMessagesCursor(cursor: string): KiloSdkMessagesCursor {
  const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (base64.length % 4)) % 4;
  const binary = atob(base64 + '='.repeat(paddingLength));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return kiloSdkMessagesCursorSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export function validateKiloSdkMessagesCursor(cursor: string): boolean {
  try {
    decodeKiloSdkMessagesCursor(cursor);
    return true;
  } catch {
    return false;
  }
}

export const getCloudAgentRootSessionMessagesSchema = resolveCloudAgentRootSessionSchema
  .extend({
    limit: z.number().int().nonnegative().max(MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE).optional(),
    before: z.string().min(1).optional(),
  })
  .superRefine((params, ctx) => {
    if (params.before !== undefined && (params.limit === undefined || params.limit === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['before'],
        message: 'before requires a positive limit',
      });
      return;
    }
    if (params.before !== undefined && !validateKiloSdkMessagesCursor(params.before)) {
      ctx.addIssue({
        code: 'custom',
        path: ['before'],
        message: 'before is not a valid message cursor',
      });
    }
  });
export type GetCloudAgentRootSessionMessagesParams = z.input<
  typeof getCloudAgentRootSessionMessagesSchema
>;
export type CloudAgentRootSessionMessages = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
  history: KiloSdkMessageHistory | null;
};
export type GetCloudAgentRootSessionMessagesResult = CloudAgentRootSessionMessages | null;

export type SessionIngestRpcMethods = {
  createSessionForCloudAgent: (params: CreateSessionForCloudAgentParams) => Promise<void>;
  deleteSessionForCloudAgent: (params: DeleteSessionForCloudAgentParams) => Promise<void>;
  resolveCloudAgentRootSessionForKiloSession: (
    params: ResolveCloudAgentRootSessionForKiloSessionParams
  ) => Promise<ResolveCloudAgentRootSessionForKiloSessionResult>;
  getCloudAgentRootSessionSnapshot: (
    params: GetCloudAgentRootSessionSnapshotParams
  ) => Promise<GetCloudAgentRootSessionSnapshotResult>;
  listCloudAgentRootSessions: (
    params: ListCloudAgentRootSessionsParams
  ) => Promise<CloudAgentRootSessionSummary[]>;
  getCloudAgentRootSessionMessages: (
    params: GetCloudAgentRootSessionMessagesParams
  ) => Promise<GetCloudAgentRootSessionMessagesResult>;
};
