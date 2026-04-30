/**
 * Badge-bucket key builders. Per-user badge state lives in `NotificationChannelDO`
 * storage under `bucket:${badgeBucket}`; producers of unread counts MUST derive
 * their bucket key via these helpers so namespaces don't collide as more surfaces
 * start emitting badge updates.
 */

export const badgeBucketForConversation = (sandboxId: string, conversationId: string) =>
  `kiloclaw:${sandboxId}:${conversationId}` as const;

export const badgeBucketForInstance = (sandboxId: string): `kiloclaw:${string}` =>
  `kiloclaw:${sandboxId}`;
