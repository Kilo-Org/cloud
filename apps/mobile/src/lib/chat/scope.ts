/**
 * Which account and organization a chat belongs to.
 *
 * A chat is private to the person who had it and to the organization whose
 * credit paid for it, so every read and every write is scoped. The harness SDK
 * holds the conversation and knows nothing about either, which is why this is
 * the app's to keep.
 *
 * Personal has a name of its own rather than an empty one, so a bug that lost
 * the organization cannot quietly read another scope's chats.
 */
export function chatScope(userId: string, organizationId: string | null | undefined): string {
  return `${userId}:${organizationId ?? 'personal'}`;
}
