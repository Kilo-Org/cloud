import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalizeValidatedInput } from '@kilocode/agent-harness/commands';
import { withTimeout } from '@kilocode/worker-utils';
import {
  ConversationSchema,
  ErrorSchema,
  LegacyMessageSchema,
  MessageSchema,
  type Message,
} from '@kilocode/agent-harness/contracts';
import {
  QuickChatAuthorityError,
  QuickChatAuthoritySchema,
  type QuickChatAuthority,
  type QuickChatProjection,
} from '../../../packages/db/src/quick-chat-runtime';
import type {
  HistoryDelivery,
  HistoryProgress,
  LegacyHistoryImporter,
} from '../../../apps/web/src/lib/agent-harness/history';
import type { ConversationStore } from './db/store';
import * as s from './db/sqlite-schema';
import { StoreError } from './db/wake';
import { fail, RuntimeError } from './limits';

export const HistoryProgressSchema = z.strictObject({
  deliveries: z
    .array(
      z.strictObject({
        id: z.uuid(),
        status: z.enum(['acknowledged', 'retry', 'rejected']),
      })
    )
    .max(50),
  backlog: z.enum(['pending', 'drained']),
});
export type { HistoryProgress };
export type LegacyAdapter = {
  // Resolve current primary account/context authority and request-client access where applicable.
  // The stored scope is a comparison target, never proof of authorization.
  authorize: (operation: 'read' | 'import' | 'project' | 'drain') => Promise<unknown>;
  // Compose the landed drainLegacyHistoryWithProgress at the authenticated server boundary.
  drain: (
    authority: QuickChatAuthority,
    importer: LegacyHistoryImporter,
    limit: number,
    signal: AbortSignal
  ) => Promise<HistoryProgress>;
  projectText: (authority: QuickChatAuthority, text: QuickChatProjection) => Promise<string>;
};
const same = (left: unknown, right: unknown) =>
  canonicalizeValidatedInput(left) === canonicalizeValidatedInput(right);
const AuthorizationSchema = z.union([
  QuickChatAuthoritySchema.strict(),
  z.strictObject({ error: ErrorSchema }),
]);

export function createLegacyCoordinator(
  original: ConversationStore,
  expected: QuickChatAuthority,
  adapter: LegacyAdapter,
  now: () => number = Date.now
) {
  const scope = QuickChatAuthoritySchema.parse(expected);
  async function authorize(
    operation: Parameters<LegacyAdapter['authorize']>[0],
    timeoutMs?: number
  ) {
    let result: z.infer<typeof AuthorizationSchema>;
    try {
      const request = adapter.authorize(operation);
      // Bound the raw request, not this function: a late reply must never bind deleted state.
      result = AuthorizationSchema.parse(
        await (timeoutMs === undefined
          ? request
          : withTimeout(request, timeoutMs, 'Primary authority exceeded its deadline.'))
      );
    } catch (error) {
      if (error instanceof QuickChatAuthorityError || error instanceof z.ZodError)
        fail('access_revoked', 'The conversation has no valid current primary authority.');
      if (error instanceof RuntimeError) throw error;
      fail('storage_unavailable', 'Primary authority is unavailable. Retry synchronization.', true);
    }
    if ('error' in result) throw new RuntimeError(result.error);
    if (!same(scope, result))
      fail('access_revoked', 'The conversation authority no longer matches.');
    original.bindExistingConversation(
      ConversationSchema.parse({
        id: scope.threadId,
        ownerUserId: scope.userId,
        context:
          scope.organizationId === null
            ? { type: 'personal' }
            : { type: 'organization', organizationId: scope.organizationId },
      })
    );
    return result;
  }
  const importLegacy: LegacyHistoryImporter = async input => {
    const authority = QuickChatAuthoritySchema.parse(input.authority);
    if (!same(scope, authority)) fail('access_revoked', 'The import belongs to another authority.');
    // Deployed appends, including assistant text, have no executable authority. Keep this normalizer
    // until every old writer and historical row is gone. clientId and timestamps are not ingress cursors.
    const message = LegacyMessageSchema.parse(input.message);
    await authorize('import');
    await original.transition({ wakeAt: null }, db => {
      const old = db.select().from(s.messages).where(eq(s.messages.id, message.id)).get();
      if (old && !same(MessageSchema.parse(old.data), message))
        throw new StoreError('command_conflict');
      // The canonical UUID row is the deduplication record; its text and event commit together.
      return { events: old ? [] : [{ type: 'message', message }] };
    });
    await authorize('import');
    return { ...scope, messageId: message.id, durable: true };
  };
  function projection(message: Message): QuickChatProjection {
    if (message.provenance !== 'harness' || message.incomplete)
      fail('invalid_input', 'Only completed authoritative text can be projected.');
    // Old readers accept ordinary text, not harness parts. Keep this projection until they retire.
    return {
      id: message.id,
      key: `agent-harness:${scope.threadId}:${message.id}`,
      role: message.role,
      content: message.content,
      clientId: message.clientId,
      createdAt: message.createdAt,
    };
  }
  const store: ConversationStore = {
    ...original,
    transition(options, write) {
      const dueAt = now();
      // The callback produces events only inside the synchronous transaction. Prearm conservatively
      // before discovering whether it also creates projection work; idle wakes remain harmless.
      return original.transition(
        { ...options, wakeAt: Math.min(options.wakeAt ?? dueAt, dueAt) },
        db => {
          const changes = write(db);
          for (const event of changes.events) {
            if (
              event.type !== 'message' ||
              event.message.provenance !== 'harness' ||
              event.message.incomplete ||
              !event.message.content
            )
              continue;
            const message = MessageSchema.parse(event.message);
            const text = projection(message);
            const old = db
              .select()
              .from(s.projectionWork)
              .where(eq(s.projectionWork.id, text.key))
              .get();
            if (old) {
              if (!same(projection(MessageSchema.parse(old.data)), text))
                throw new StoreError('command_conflict');
            } else
              db.insert(s.projectionWork)
                .values({
                  id: text.key,
                  messageId: message.id,
                  data: message,
                  dueAt,
                })
                .run();
          }
          return changes;
        }
      );
    },
  };
  async function drainLegacy(signal: AbortSignal = AbortSignal.timeout(30_000)) {
    try {
      signal.throwIfAborted();
      const authority = await authorize('drain');
      const progress = HistoryProgressSchema.parse(
        await adapter.drain(authority, importLegacy, 50, signal)
      );
      signal.throwIfAborted();
      await authorize('drain');
      return progress;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      if (error instanceof QuickChatAuthorityError)
        fail('access_revoked', 'The legacy source no longer has primary authority.');
      if (error instanceof z.ZodError)
        fail('invalid_output', 'The legacy source returned invalid progress.');
      fail('storage_unavailable', 'Legacy ingress is unavailable. Retry synchronization.', true);
    }
  }
  async function drainProjections(limit = 50, timeoutMs = 30_000): Promise<HistoryDelivery[]> {
    z.int().min(1).max(50).parse(limit);
    // One local deadline bounds the whole batch, independently of its durable retry clock.
    const deadline = Date.now() + z.int().positive().max(30_000).parse(timeoutMs);
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0)
        fail(
          'storage_unavailable',
          'Projection delivery exceeded its deadline. Retry synchronization.',
          true
        );
      return milliseconds;
    };
    // Alarm entry must leave recovery armed before the first primary request, including an outage.
    await original.transition({ wakeAt: now() + 60_000 }, () => ({ events: [] }));
    await authorize('project', remaining());
    const deliveries: HistoryDelivery[] = [];
    for (const row of original.pendingProjections(now(), limit)) {
      if (Date.now() >= deadline) break;
      let claimed = false;
      const retryAt = now() + 60_000;
      await original.transition({ wakeAt: retryAt }, db => {
        claimed = Boolean(
          db
            .update(s.projectionWork)
            .set({ revision: row.revision + 1, dueAt: retryAt })
            .where(
              and(
                eq(s.projectionWork.id, row.id),
                eq(s.projectionWork.revision, row.revision),
                isNull(s.projectionWork.acknowledgedAt)
              )
            )
            .returning({ id: s.projectionWork.id })
            .get()
        );
        return { events: [] };
      });
      if (!claimed) continue;
      try {
        const authority = await authorize('project', remaining());
        const text = projection(MessageSchema.parse(row.data));
        if (text.key !== row.id || text.id !== row.messageId)
          fail('invalid_input', 'The projection identity does not match its durable work.');
        const requestTimeout = remaining();
        if (
          (await withTimeout(
            adapter.projectText(authority, text),
            requestTimeout,
            'Primary projection exceeded its deadline.'
          )) !== row.messageId
        )
          fail('invalid_output', 'The projection acknowledgment belongs to another message.');
        await authorize('project', remaining());
        remaining();
        const acknowledged = original.acknowledgeProjection(
          row.id,
          row.revision + 1,
          new Date(now()).toISOString()
        );
        deliveries.push({ id: row.messageId, status: acknowledged ? 'acknowledged' : 'retry' });
      } catch (error) {
        deliveries.push({
          id: row.messageId,
          status:
            error instanceof QuickChatAuthorityError ||
            (error instanceof RuntimeError && !error.detail.retryable)
              ? 'rejected'
              : 'retry',
        });
      }
    }
    return deliveries;
  }
  return { store, authorize, importLegacy, drainLegacy, drainProjections };
}
