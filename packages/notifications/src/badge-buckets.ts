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

export type ParsedBadgeBucket =
  | {
      kind: 'kiloclaw-instance';
      sandboxId: string;
    }
  | {
      kind: 'kiloclaw-conversation';
      sandboxId: string;
      conversationId: string;
    }
  | {
      kind: 'unknown';
      badgeBucket: string;
    };

export function parseBadgeBucket(badgeBucket: string): ParsedBadgeBucket {
  const parts = badgeBucket.split(':');
  if (parts[0] !== 'kiloclaw' || !parts[1]) {
    return { kind: 'unknown', badgeBucket };
  }
  if (parts.length === 2) {
    return { kind: 'kiloclaw-instance', sandboxId: parts[1] };
  }
  if (parts.length === 3 && parts[2]) {
    return { kind: 'kiloclaw-conversation', sandboxId: parts[1], conversationId: parts[2] };
  }
  return { kind: 'unknown', badgeBucket };
}

export function parentBadgeBucketFor(badgeBucket: string): string {
  const parsed = parseBadgeBucket(badgeBucket);
  return parsed.kind === 'kiloclaw-conversation'
    ? badgeBucketForInstance(parsed.sandboxId)
    : badgeBucket;
}
