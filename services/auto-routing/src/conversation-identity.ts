import type { NormalizedClassifierInput } from './classifier-input';

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

// Stable conversation identity even when the client sends no session id:
// the first user prompt and system prompt do not change within a
// conversation, so their fingerprint identifies it.
export function deriveConversationKey(sessionId: string | null, hashes: ContentHashes): string {
  return sessionId ?? `content:${hashes.loose}`;
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
