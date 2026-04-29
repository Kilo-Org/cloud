/**
 * Badge-bucket key builders. The `badge_counts` table uses a free-form
 * `badge_bucket` string as part of its composite PK; producers of unread
 * counts MUST derive their bucket key via these helpers so namespaces
 * don't collide as more surfaces start emitting badge updates.
 */

export const badgeBucketForInstance = (sandboxId: string) => `kiloclaw:${sandboxId}` as const;

export const badgeBucketForConversation = (sandboxId: string, conversationId: string) =>
  `kiloclaw:${sandboxId}:${conversationId}` as const;
