import type { KiloChatEventName, KiloChatEventOf, BotStatusEvent } from '@kilocode/kilo-chat';
import { withDORetry } from '@kilocode/worker-utils';
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
  for (const r of results) {
    if (r.status === 'fulfilled') {
      map.set(r.value[0], r.value[1]);
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

  await Promise.allSettled(
    humanMemberIds.map(userId => es.pushEvent(userId, context, event, payload))
  );
}

/**
 * Resolves the sandbox owner and pushes a `bot.status` event to them on the
 * instance-level context. Returns `false` when no active owner exists.
 */
export async function pushBotStatusEvent(
  env: Env,
  sandboxId: string,
  payload: BotStatusEvent
): Promise<{ delivered: boolean; ownerUserId: string | null }> {
  const ownerUserId = await lookupSandboxOwnerUserId(env, sandboxId);
  if (!ownerUserId) return { delivered: false, ownerUserId: null };
  await pushInstanceEvent(env, sandboxId, [ownerUserId], 'bot.status', payload);
  return { delivered: true, ownerUserId };
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
