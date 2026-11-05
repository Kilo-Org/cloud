import { z } from 'zod';
import type { PermissionRequest, QuestionRequest } from '@kilocode/sdk/v2';
import {
  kilo2FormSchema,
  kilo2MessageSchema,
  kilo2PermissionSchema,
  kilo2SessionPath,
  kilo2SessionSchema,
  type Kilo2Api,
} from './kilo2-api.js';
import { KILO_ACTIVITY_MESSAGE_LIMIT } from '../kilo-api.js';
import { kilo2MessageActivity } from './kilo2-message-activity.js';
export const kilo2LocationQuery = (directory: string) =>
  `location[directory]=${encodeURIComponent(directory)}`;
const locationQuery = kilo2LocationQuery;
const pageSchema = z.object({
  data: z.array(kilo2SessionSchema),
  cursor: z.object({ next: z.string().nullish() }),
});
const messagePageSchema = z.object({
  data: z.array(kilo2MessageSchema),
  cursor: z.object({ next: z.string().nullish() }),
});

export function projectKilo2Question(form: z.infer<typeof kilo2FormSchema>): QuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    blocking: true,
    ...(form.metadata?.tool
      ? { tool: { messageID: form.metadata.tool.messageID, callID: form.metadata.tool.id } }
      : {}),
    questions: form.fields.map(field => ({
      header: field.title ?? form.title,
      question: field.description ?? field.title ?? form.title,
      options: (field.options ?? []).map(option => ({
        label: option.label,
        description: option.description ?? '',
      })),
      multiple: field.type === 'multiselect',
      custom: field.custom ?? !field.options?.length,
    })),
  };
}

export function projectKilo2Permission(
  request: z.infer<typeof kilo2PermissionSchema>
): PermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission:
      request.action === 'shell' ? 'bash' : request.action === 'subagent' ? 'task' : request.action,
    patterns: request.resources,
    always: request.save ?? [],
    metadata: request.metadata ?? {},
    ...(request.source
      ? { tool: { messageID: request.source.messageID, callID: request.source.id } }
      : {}),
  };
}

export function createKilo2Reads(api: Kilo2Api, defaultDirectory: string) {
  async function session(id: string, signal?: AbortSignal) {
    return kilo2SessionSchema.parse(await api.data(kilo2SessionPath(id), { signal }));
  }
  async function list(directory?: string, signal?: AbortSignal) {
    const sessions: z.infer<typeof kilo2SessionSchema>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        limit: '100',
        ...(directory ? { directory } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const page = pageSchema.parse(await api.request(`/api/session?${query}`, { signal }));
      sessions.push(...page.data);
      if (sessions.length > 1000)
        throw new Error('Kilo v2 session discovery exceeded its bounded window');
      cursor = page.cursor.next ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Kilo v2 session pagination did not advance');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return sessions;
  }
  /** The latest native messages, oldest first, with their session. */
  async function messages(id: string, signal?: AbortSignal) {
    const [info, raw] = await Promise.all([
      session(id, signal),
      api.request(
        `${kilo2SessionPath(id)}/message?limit=${KILO_ACTIVITY_MESSAGE_LIMIT}&order=desc`,
        { signal }
      ),
    ]);
    return { session: info, messages: messagePageSchema.parse(raw).data.toReversed() };
  }
  const reads = {
    async getSessionDetails(id: string, _directory: string, signal?: AbortSignal) {
      const info = await session(id, signal);
      return { id: info.id, directory: info.location.directory, parentID: info.parentID };
    },
    async listSessionMetadata(signal: AbortSignal) {
      return (await list(undefined, signal)).map(info => ({
        id: info.id,
        directory: info.location.directory,
        parentID: info.parentID,
      }));
    },
    async getRecentActivity(id: string, _directory: string, signal: AbortSignal) {
      const page = await messages(id, signal);
      return page.messages.flatMap(message => kilo2MessageActivity(id, message) ?? []);
    },
    async getMessageActivity(
      id: string,
      _directory: string,
      messageId: string,
      signal: AbortSignal
    ) {
      const raw = await api.data(
        `${kilo2SessionPath(id)}/message/${encodeURIComponent(messageId)}`,
        { signal }
      );
      const message = kilo2MessageActivity(id, kilo2MessageSchema.parse(raw));
      if (!message) throw new Error('Kilo v2 message is not a conversation message');
      return message;
    },
    async getSessionStatuses(directory = defaultDirectory, signal?: AbortSignal) {
      const active = z
        .record(z.string(), z.object({ type: z.literal('running') }))
        .parse(await api.data('/api/session/active', { signal }));
      const sessions = await list(directory, signal);
      return Object.fromEntries(
        sessions.filter(info => active[info.id]).map(info => [info.id, { type: 'busy' }])
      );
    },
    async getQuestions(directory = defaultDirectory, signal?: AbortSignal) {
      return z
        .array(kilo2FormSchema)
        .parse(await api.data(`/api/form?${locationQuery(directory)}`, { signal }))
        .map(projectKilo2Question);
    },
    async getPermissions(directory = defaultDirectory, signal?: AbortSignal) {
      return z
        .array(kilo2PermissionSchema)
        .parse(await api.data(`/api/permission/request?${locationQuery(directory)}`, { signal }))
        .map(projectKilo2Permission);
    },
    async getSuggestions() {
      return [];
    },
    async getSessionTodos() {
      return [];
    },
    // The bounded worktree capture owns diff state; the native v2 diff is not used.
    async getSessionDiff() {
      return [];
    },
  };
  return { reads, session, list, messages };
}
