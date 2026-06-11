import type { NormalizedClassifierInput } from '@kilocode/auto-routing-contracts';

// Identity scheme for the decision cache: which conversation a mirrored
// request belongs to, and which exact classifier input it carries. Owning
// both here keeps the cache-key contract in one module.

const textEncoder = new TextEncoder();

export type ContentHashes = {
  // Includes the bucketed message count, so it only matches requests at a
  // similar conversation depth.
  exact: string;
  // Ignores message count entirely; matches any request with the same
  // prompt prefixes.
  loose: string;
};

export type ConversationIdentity = {
  userId: string;
  sessionId: string | null;
  machineId: string | null;
};

// Conversation identity, always scoped by the authenticated user so
// distinct callers never share a cache object even when they send equal
// session ids or prompts. Within a user, the session id wins; without one
// the machine id gives a stable per-device identity, and as a last resort
// the prompt-prefix fingerprint groups requests of the same conversation.
export function deriveConversationKey(
  identity: ConversationIdentity,
  hashes: ContentHashes
): string {
  const conversationScope = identity.sessionId
    ? `task:${identity.sessionId}`
    : identity.machineId
      ? `machine:${identity.machineId}`
      : `content:${hashes.loose}`;
  return `user:${identity.userId}:${conversationScope}`;
}

// The conversation key embeds the raw user id (and the client IP for
// anonymous users), which must not leave our infrastructure. Outbound
// session affinity (OpenRouter sticky routing) gets a hash with the same
// per-conversation stability instead.
export function deriveOutboundSessionId(conversationKey: string): Promise<string> {
  return sha256Hex16(conversationKey);
}

// One-way hash for identifiers that appear in telemetry (logs, analytics):
// preserves correlation across events without persisting the raw id, which
// for anonymous users embeds the client IP. Raw identity stays confined to
// cache scoping.
export function hashIdentifierForTelemetry(value: string): Promise<string> {
  return sha256Hex16(value);
}

export async function computeContentHashes(
  input: NormalizedClassifierInput
): Promise<ContentHashes> {
  // Canonical JSON encoding rather than a delimiter join: prompt fields can
  // contain any character (including a delimiter), so joining on one would
  // let distinct inputs collide onto the same hash.
  const fields = [
    input.apiKind,
    input.hasTools,
    input.systemPromptPrefix?.slice(0, 200) ?? '',
    input.userPromptPrefix?.slice(0, 800) ?? '',
    input.latestUserPromptPrefix?.slice(0, 800) ?? '',
  ];
  const [loose, exact] = await Promise.all([
    sha256Hex16(JSON.stringify(fields)),
    sha256Hex16(JSON.stringify([...fields, messageCountBucket(input.messageCount)])),
  ]);
  return { exact, loose };
}

function messageCountBucket(messageCount: number | null): number {
  if (messageCount === null || messageCount < 1) return -1;
  return Math.floor(Math.log2(messageCount));
}

async function sha256Hex16(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}
