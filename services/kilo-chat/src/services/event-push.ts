import type {
  KiloChatEventName,
  KiloChatEventOf,
  BotStatusRequest,
  ConversationStatusRequest,
} from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import { lookupSandboxOwnerUserId } from './sandbox-ownership';

function getEventService(env: Env): Env['EVENT_SERVICE'] | null {
  return env.EVENT_SERVICE ?? null;
}

/**
 * Pushes an event to the event-service for each human member of a conversation.
 * Returns a map of userId → delivered (true if the user had an active WS in context).
 */
export async function pushEventToHumanMembers<N extends KiloChatEventName>(
  env: Env,
  conversationId: string,
  sandboxId: string,
  humanMemberIds: string[],
  event: N,
  payload: KiloChatEventOf<N>
): Promise<Map<string, boolean>> {
  const es = getEventService(env);
  if (!es) return new Map();
  const context = `/kiloclaw/${sandboxId}/${conversationId}`;

  const results = await Promise.allSettled(
    humanMemberIds.map(async userId => {
      const delivered = await es.pushEvent(userId, context, event, payload);
      return [userId, delivered] as const;
    })
  );

  const map = new Map<string, boolean>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      map.set(r.value[0], r.value[1]);
    } else {
      logger.error('event-service pushEvent failed for conversation member', {
        userId: humanMemberIds[i],
        conversationId,
        event,
        ...formatError(r.reason),
      });
    }
  }
  return map;
}

/**
 * Pushes an event on the instance-level context (`/kiloclaw/{sandboxId}`).
 * Used for cross-conversation notifications (e.g. new activity in a conversation).
 */
export async function pushInstanceEvent<N extends KiloChatEventName>(
  env: Env,
  sandboxId: string,
  humanMemberIds: string[],
  event: N,
  payload: KiloChatEventOf<N>
): Promise<void> {
  const es = getEventService(env);
  if (!es) return;
  const context = `/kiloclaw/${sandboxId}`;

  const results = await Promise.allSettled(
    humanMemberIds.map(userId => es.pushEvent(userId, context, event, payload))
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      logger.error('event-service pushEvent failed for instance member', {
        userId: humanMemberIds[i],
        sandboxId,
        event,
        ...formatError(r.reason),
      });
    }
  }
}

/**
 * Resolves the sandbox owner, persists the heartbeat to `SandboxStatusDO`, and
 * pushes a `bot.status` event to the owner on the instance-level context.
 * Returns `ownerUserId: null` when no active owner exists. Note: this does not
 * report whether the WS push reached an online client — use the event-service
 * directly if that signal is required.
 */
export async function pushBotStatus(
  env: Env,
  sandboxId: string,
  body: BotStatusRequest
): Promise<{ ownerUserId: string | null }> {
  const ownerUserId = await lookupSandboxOwnerUserId(env, sandboxId);
  if (!ownerUserId) return { ownerUserId: null };

  // Both legs swallow their own errors internally and always resolve; plain
  // Promise.all is sufficient and will fail fast if that contract ever breaks.
  await Promise.all([
    persistBotStatus(env, sandboxId, body),
    pushInstanceEvent(env, sandboxId, [ownerUserId], 'bot.status', { sandboxId, ...body }),
  ]);
  return { ownerUserId };
}

async function persistBotStatus(
  env: Env,
  sandboxId: string,
  body: BotStatusRequest
): Promise<void> {
  try {
    await withDORetry(
      () => env.SANDBOX_STATUS_DO.get(env.SANDBOX_STATUS_DO.idFromName(sandboxId)),
      stub => stub.putBotStatus(body),
      'SandboxStatusDO.putBotStatus'
    );
  } catch (err) {
    logger.error('persistBotStatus failed', { sandboxId, ...formatError(err) });
  }
}

/**
 * Resolves the sandbox owner, persists the post-turn snapshot to
 * `SandboxStatusDO`, and pushes a `conversation.status` event to the owner on
 * the conversation-scoped context. Returns `ownerUserId: null` when no active
 * owner exists. Does not report WS delivery.
 */
export async function pushConversationStatus(
  env: Env,
  sandboxId: string,
  conversationId: string,
  body: ConversationStatusRequest
): Promise<{ ownerUserId: string | null }> {
  const ownerUserId = await lookupSandboxOwnerUserId(env, sandboxId);
  if (!ownerUserId) return { ownerUserId: null };

  await Promise.all([
    persistConversationStatus(env, sandboxId, conversationId, body),
    pushEventToHumanMembers(env, conversationId, sandboxId, [ownerUserId], 'conversation.status', {
      conversationId,
      ...body,
    }),
  ]);
  return { ownerUserId };
}

async function persistConversationStatus(
  env: Env,
  sandboxId: string,
  conversationId: string,
  body: ConversationStatusRequest
): Promise<void> {
  try {
    await withDORetry(
      () => env.SANDBOX_STATUS_DO.get(env.SANDBOX_STATUS_DO.idFromName(sandboxId)),
      stub => stub.putConversationStatus({ conversationId, ...body }),
      'SandboxStatusDO.putConversationStatus'
    );
  } catch (err) {
    logger.error('persistConversationStatus failed', {
      sandboxId,
      conversationId,
      ...formatError(err),
    });
  }
}

/**
 * Extracts sandboxId from a bot member ID like "bot:kiloclaw:sandbox_123".
 */
export function extractSandboxId(botMemberId: string): string | null {
  const match = botMemberId.match(/^bot:kiloclaw:(.+)$/);
  return match?.[1] ?? null;
}

/**
 * Gets human member IDs and sandboxId for a conversation.
 * Used by webhook delivery failure notification.
 */
export async function getConversationContext(
  env: Env,
  conversationId: string
): Promise<{ humanMemberIds: string[]; sandboxId: string | null } | null> {
  const info = await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.getInfo(),
    'ConversationDO.getInfo'
  );
  if (!info) return null;

  const humanMemberIds = info.members.filter(m => m.kind === 'user').map(m => m.id);
  const botMember = info.members.find(m => m.kind === 'bot');
  const sandboxId = botMember ? extractSandboxId(botMember.id) : null;

  return { humanMemberIds, sandboxId };
}

/**
 * Derives conversation context from an already-fetched ConversationInfo members array.
 * Use this to avoid a redundant getInfo() call when info is already available.
 */
export function extractConversationContext(members: Array<{ id: string; kind: string }>): {
  humanMemberIds: string[];
  sandboxId: string | null;
} {
  const humanMemberIds = members.filter(m => m.kind === 'user').map(m => m.id);
  const botMember = members.find(m => m.kind === 'bot');
  const sandboxId = botMember ? extractSandboxId(botMember.id) : null;
  return { humanMemberIds, sandboxId };
}
