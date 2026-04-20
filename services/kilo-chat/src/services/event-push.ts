type EventServiceBinding = {
  pushEvent: (userId: string, context: string, event: string, payload: unknown) => Promise<void>;
  userPresent: (userId: string, context: string) => Promise<boolean>;
};

function getEventService(env: Env): EventServiceBinding | null {
  if (!env.EVENT_SERVICE) return null;
  return env.EVENT_SERVICE as unknown as EventServiceBinding;
}

/**
 * Pushes an event to the event-service for each human member of a conversation.
 * Fire-and-forget: failures are logged but don't block the caller.
 */
export async function pushEventToHumanMembers(
  env: Env,
  conversationId: string,
  sandboxId: string,
  humanMemberIds: string[],
  event: string,
  payload: unknown
): Promise<void> {
  const es = getEventService(env);
  if (!es) return;
  const context = `/kiloclaw/${sandboxId}/${conversationId}`;

  await Promise.allSettled(
    humanMemberIds.map(userId => es.pushEvent(userId, context, event, payload))
  );
}

/**
 * Pushes an event on the instance-level context (`/kiloclaw/{sandboxId}`).
 * Used for cross-conversation notifications (e.g. new activity in a conversation).
 */
export async function pushInstanceEvent(
  env: Env,
  sandboxId: string,
  humanMemberIds: string[],
  event: string,
  payload: unknown
): Promise<void> {
  const es = getEventService(env);
  if (!es) return;
  const context = `/kiloclaw/${sandboxId}`;

  await Promise.allSettled(
    humanMemberIds.map(userId => es.pushEvent(userId, context, event, payload))
  );
}

/**
 * Checks if a user is present (has an active WS connection) in a conversation context.
 */
export async function isUserPresentInConversation(
  env: Env,
  userId: string,
  sandboxId: string,
  conversationId: string
): Promise<boolean> {
  const es = getEventService(env);
  if (!es) return false;
  const context = `/kiloclaw/${sandboxId}/${conversationId}`;
  try {
    return await es.userPresent(userId, context);
  } catch {
    return false;
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
 */
export async function getConversationContext(
  env: Env,
  conversationId: string
): Promise<{ humanMemberIds: string[]; sandboxId: string | null } | null> {
  const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));
  const info = await stub.getInfo();
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
