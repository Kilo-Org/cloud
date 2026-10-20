import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getWorkerRequest, type CapturedRequest } from '@/lib/webhook-agent/webhook-agent-client';
import { fetchSessionSnapshot } from '@/lib/session-ingest-client';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import {
  v1BlobToLogEntries,
  v2SnapshotToLogEntries,
  type SessionLogEntry,
} from '@/lib/code-reviews/session-log';
import type { Part, StoredMessage, TextPart, ToolPart } from '@/components/cloud-agent-next/types';
import { isTextPart, isToolPart } from '@/components/cloud-agent-next/types';
import {
  convertToCloudMessages,
  type CloudMessage,
} from '@/components/cloud-agent-next/legacy-session-types';
import { toSharedTranscriptMessages } from '@/app/s/[sessionId]/shared-transcript';

export type WebhookRequestTranscript =
  | { version: 'v2'; messages: StoredMessage[] }
  | { version: 'v1'; messages: CloudMessage[] }
  | null;

export type WebhookRequestLogs = {
  logs: SessionLogEntry[];
  transcript: WebhookRequestTranscript;
  processStatus: CapturedRequest['processStatus'];
  logsReady: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseV1Messages(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (message): message is Record<string, unknown> =>
      typeof message === 'object' && message !== null && !Array.isArray(message)
  );
}

function sanitizeV1ToolMetadata(message: CloudMessage): Record<string, unknown> {
  const metadata = isRecord(message.metadata) ? message.metadata : undefined;
  const tool =
    typeof metadata?.tool === 'string'
      ? metadata.tool
      : message.ask === 'command'
        ? 'command'
        : 'tool';
  const path =
    typeof metadata?.path === 'string'
      ? metadata.path
      : typeof metadata?.filePath === 'string'
        ? metadata.filePath
        : undefined;
  const command = typeof metadata?.command === 'string' ? metadata.command : undefined;

  return {
    tool,
    ...(path !== undefined ? { path } : {}),
    ...(command !== undefined ? { command } : {}),
  };
}

function sanitizeV1Message(message: CloudMessage): CloudMessage | null {
  const text =
    (typeof message.text === 'string' ? message.text : '') ||
    (typeof message.content === 'string' ? message.content : '');

  if (message.type === 'user') {
    if (!text.trim()) return null;
    return {
      ts: message.ts,
      type: 'user',
      say: message.say,
      ask: message.ask,
      text,
      content: text,
      partial: message.partial,
    };
  }

  if (message.type !== 'assistant') return null;

  const isTool = message.say === 'tool' || message.ask === 'tool' || message.ask === 'command';
  if (isTool) {
    return {
      ts: message.ts,
      type: 'assistant',
      say: message.say,
      ask: message.ask,
      text: '',
      content: '',
      partial: message.partial,
      metadata: sanitizeV1ToolMetadata(message),
    };
  }

  if (message.say === 'api_req_started') {
    return {
      ts: message.ts,
      type: 'assistant',
      say: message.say,
      ask: message.ask,
      text: '',
      content: '',
      partial: message.partial,
    };
  }

  if (message.say === 'text' || message.say === 'completion_result' || message.say === 'error') {
    if (message.say !== 'error' && !text.trim()) return null;
    return {
      ts: message.ts,
      type: 'assistant',
      say: message.say,
      ask: message.ask,
      text,
      content: text,
      partial: message.partial,
    };
  }

  return null;
}

function sanitizeV1Transcript(messages: CloudMessage[]): CloudMessage[] {
  return messages
    .map(sanitizeV1Message)
    .filter((message): message is CloudMessage => message !== null);
}

function sanitizeToolInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};

  for (const key of ['filePath', 'file_path', 'path']) {
    if (typeof input[key] === 'string') return { [key]: input[key] };
  }
  if (typeof input.command === 'string') return { command: input.command };
  for (const key of ['query', 'pattern']) {
    if (typeof input[key] === 'string') return { [key]: input[key] };
  }
  return {};
}

function startTime(value: unknown): number {
  return isRecord(value) && typeof value.start === 'number' ? value.start : 0;
}

function endTime(value: unknown): number {
  return isRecord(value) && typeof value.end === 'number' ? value.end : 0;
}

function sanitizeV2ToolPart(part: ToolPart): ToolPart | null {
  if (part.tool === 'plan_enter' || part.tool === 'plan_exit') return null;

  const state = part.state;
  if (!isRecord(state)) return null;
  const input = sanitizeToolInput(state.input);
  const base = {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'tool' as const,
    callID: part.callID,
    tool: part.tool,
  };

  if (state.status === 'pending') {
    return { ...base, state: { status: 'pending', input, raw: '' } };
  }
  if (state.status === 'running') {
    return {
      ...base,
      state: { status: 'running', input, time: { start: startTime(state.time) } },
    };
  }
  if (state.status === 'completed') {
    return {
      ...base,
      state: {
        status: 'completed',
        input,
        output: '',
        title: '',
        metadata: {},
        time: { start: startTime(state.time), end: endTime(state.time) },
      },
    };
  }
  if (state.status === 'error') {
    return {
      ...base,
      state: {
        status: 'error',
        input,
        error: typeof state.error === 'string' ? state.error : '',
        time: { start: startTime(state.time), end: endTime(state.time) },
      },
    };
  }
  return null;
}

function sanitizeV2Parts(parts: Part[]): Part[] {
  const sanitized: Part[] = [];

  for (const part of parts) {
    if (isTextPart(part)) {
      if (typeof part.text !== 'string' || !part.text.trim()) continue;
      if (part.synthetic === true && part.text.includes('Initializing snapshot')) continue;

      const textPart: TextPart = {
        id: part.id,
        sessionID: part.sessionID,
        messageID: part.messageID,
        type: 'text',
        text: part.text,
      };
      if (typeof part.synthetic === 'boolean') textPart.synthetic = part.synthetic;
      if (isRecord(part.time) && typeof part.time.start === 'number') {
        textPart.time = {
          start: part.time.start,
          ...(typeof part.time.end === 'number' ? { end: part.time.end } : {}),
        };
      }
      sanitized.push(textPart);
      continue;
    }

    if (isToolPart(part)) {
      const toolPart = sanitizeV2ToolPart(part);
      if (toolPart) sanitized.push(toolPart);
    }
  }

  return sanitized;
}

function messageErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.data)) return undefined;
  return typeof error.data.message === 'string' ? error.data.message : undefined;
}

function sanitizeV2Info(info: StoredMessage['info']): StoredMessage['info'] {
  if (info.role === 'user') {
    return {
      id: info.id,
      sessionID: info.sessionID,
      role: 'user',
      time: { created: info.time.created },
      agent: '',
      model: { providerID: '', modelID: '' },
    };
  }

  const errorMessage = info.error
    ? (messageErrorMessage(info.error) ?? 'An error occurred')
    : undefined;

  return {
    id: info.id,
    sessionID: info.sessionID,
    role: 'assistant',
    time: {
      created: info.time.created,
      ...(typeof info.time.completed === 'number' ? { completed: info.time.completed } : {}),
    },
    parentID: info.parentID,
    modelID: '',
    providerID: '',
    mode: '',
    agent: '',
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...(errorMessage !== undefined
      ? { error: { name: 'UnknownError' as const, data: { message: errorMessage } } }
      : {}),
  };
}

function sanitizeV2Message(message: StoredMessage): StoredMessage | null {
  const { info } = message;
  if (info.role !== 'user' && info.role !== 'assistant') return null;

  const parts = sanitizeV2Parts(message.parts);
  if (parts.length === 0 && !(info.role === 'assistant' && info.error)) return null;

  return { info: sanitizeV2Info(info), parts };
}

function sanitizeV2Transcript(messages: StoredMessage[]): StoredMessage[] {
  return messages
    .map(sanitizeV2Message)
    .filter((message): message is StoredMessage => message !== null);
}

export async function getWebhookRequestLogs(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string,
  requestId: string
): Promise<WebhookRequestLogs> {
  const result = await getWorkerRequest(userId, organizationId, triggerId, requestId);
  if (!result.success) {
    throw new TRPCError({
      code: result.status === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
      message: result.status === 404 ? 'Request not found' : 'Failed to fetch request',
    });
  }

  const empty: WebhookRequestLogs = {
    logs: [],
    transcript: null,
    processStatus: result.data.processStatus,
    logsReady: false,
  };
  const cloudAgentSessionId = result.data.cloudAgentSessionId;
  if (!cloudAgentSessionId) return empty;

  const [v1, duplicateV1] = await db
    .select({ blobUrl: cliSessions.ui_messages_blob_url })
    .from(cliSessions)
    .where(
      and(
        eq(cliSessions.cloud_agent_session_id, cloudAgentSessionId),
        organizationId
          ? eq(cliSessions.organization_id, organizationId)
          : and(eq(cliSessions.kilo_user_id, userId ?? ''), isNull(cliSessions.organization_id))
      )
    )
    .limit(2);

  if (duplicateV1) return empty;
  if (v1) {
    if (!v1.blobUrl) return empty;
    let content: unknown;
    try {
      content = await getBlobContent(v1.blobUrl);
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return empty;
      throw error;
    }
    if (content === null) return empty;
    const transcriptMessages = convertToCloudMessages(parseV1Messages(content));
    return {
      ...empty,
      logs: v1BlobToLogEntries(content),
      transcript: {
        version: 'v1',
        messages: organizationId ? sanitizeV1Transcript(transcriptMessages) : transcriptMessages,
      },
      logsReady: true,
    };
  }

  const [v2, duplicateV2] = await db
    .select({ sessionId: cli_sessions_v2.session_id, userId: cli_sessions_v2.kilo_user_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId),
        organizationId
          ? eq(cli_sessions_v2.organization_id, organizationId)
          : and(
              eq(cli_sessions_v2.kilo_user_id, userId ?? ''),
              isNull(cli_sessions_v2.organization_id)
            )
      )
    )
    .limit(2);

  if (!v2 || duplicateV2) return empty;
  const snapshot = await fetchSessionSnapshot(v2.sessionId, v2.userId);
  if (!snapshot) return empty;
  const transcriptMessages = toSharedTranscriptMessages(snapshot.messages);
  return {
    ...empty,
    logs: v2SnapshotToLogEntries(snapshot),
    transcript: {
      version: 'v2',
      messages: organizationId ? sanitizeV2Transcript(transcriptMessages) : transcriptMessages,
    },
    logsReady: true,
  };
}
