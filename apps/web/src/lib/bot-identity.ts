import 'server-only';
import crypto from 'node:crypto';
import type { SerializedMessage, SerializedThread, StateAdapter } from 'chat';
import * as z from 'zod';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { botIdentityRedisKey } from '@/lib/redis-keys';
import { PLATFORM } from '@/lib/integrations/core/constants';

const CHAT_SDK_CACHE_KEY_PREFIX = 'chat-sdk:cache:';
const LINK_ACCOUNT_CONTEXT_KEY_PREFIX = 'link-account-context:';
const REDIS_SCAN_BATCH_SIZE = 100;
const REDIS_DELETE_BATCH_SIZE = 100;

type RedisScanClient = {
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string | string[]>;
  del(keys: string[]): Promise<unknown>;
};

type StateAdapterWithRedisClient = StateAdapter & {
  getClient(): RedisScanClient;
};

function hasRedisClient(state: StateAdapter): state is StateAdapterWithRedisClient {
  return 'getClient' in state && typeof state.getClient === 'function';
}

/**
 * Platform identity coordinates — the minimum info needed to identify
 * a user on any chat platform (Slack, Discord, Teams, Google Chat, etc.).
 */
export type PlatformIdentity = {
  /** e.g. "slack", "discord", "teams", "gchat" */
  platform: (typeof PLATFORM)[keyof typeof PLATFORM];
  /** Workspace / team / guild / tenant ID, or a platform-specific user-level sentinel. */
  teamId: string;
  /** Platform-specific user ID (e.g. Slack's "U123ABC") */
  userId: string;
};

type LinkTokenPayload = {
  identity: PlatformIdentity;
  contextKey: string;
};

type LinkAccountContext = {
  thread: SerializedThread;
  message: SerializedMessage;
};

type VerifiedLinkToken = {
  contextKey: string;
  identity: PlatformIdentity;
  thread: SerializedThread;
  message: SerializedMessage;
};

/**
 * Look up the Kilo user ID linked to a chat-platform user.
 * Returns `null` when no mapping exists yet.
 */
export async function resolveKiloUserId(
  state: StateAdapter,
  identity: PlatformIdentity
): Promise<string | null> {
  const { platform, teamId, userId } = identity;
  return state.get<string>(botIdentityRedisKey(platform, teamId, userId));
}

/**
 * Persist a platform-user → Kilo-user link.
 */
export async function linkKiloUser(
  state: StateAdapter,
  identity: PlatformIdentity,
  kiloUserId: string
): Promise<void> {
  const { platform, teamId, userId } = identity;
  await state.set(botIdentityRedisKey(platform, teamId, userId), kiloUserId);
}

/**
 * Remove a previously stored link.
 */
export async function unlinkKiloUser(
  state: StateAdapter,
  identity: PlatformIdentity
): Promise<void> {
  const { platform, teamId, userId } = identity;
  await state.delete(botIdentityRedisKey(platform, teamId, userId));
}

export async function unlinkTeamKiloUsers(
  state: StateAdapter,
  platform: string,
  teamId: string
): Promise<number> {
  if (!hasRedisClient(state)) {
    return 0;
  }

  const client = state.getClient();
  const pattern = `${CHAT_SDK_CACHE_KEY_PREFIX}${botIdentityRedisKey(platform, teamId, '*')}`;
  let pendingKeys: string[] = [];
  let deletedKeys = 0;

  async function deletePendingKeys(): Promise<void> {
    if (pendingKeys.length === 0) return;

    const keysToDelete = pendingKeys;
    pendingKeys = [];
    deletedKeys += keysToDelete.length;
    await client.del(keysToDelete);
  }

  for await (const scannedKeys of client.scanIterator({
    MATCH: pattern,
    COUNT: REDIS_SCAN_BATCH_SIZE,
  })) {
    if (Array.isArray(scannedKeys)) {
      pendingKeys.push(...scannedKeys);
    } else {
      pendingKeys.push(scannedKeys);
    }

    if (pendingKeys.length >= REDIS_DELETE_BATCH_SIZE) {
      await deletePendingKeys();
    }
  }

  await deletePendingKeys();
  return deletedKeys;
}

// -- HMAC-signed link tokens --------------------------------------------------
//
// The link-account URL carries a single `token` query parameter rather than
// plain-text platform/teamId/userId.  The token is HMAC-signed and time-limited
// so a third party cannot forge a link for a team they don't belong to.
//
// Format:  base64url({ identity, contextKey, iat, nonce }) . HMAC-SHA256
//
// Follows the same pattern as src/lib/integrations/oauth-state.ts.

const HMAC_ALGORITHM = 'sha256';
const TOKEN_TTL_SECONDS = 30 * 60;
const LINK_ACCOUNT_CONTEXT_TTL_MS = TOKEN_TTL_SECONDS * 1000;
const NONCE_BYTES = 16;

const platformIdentitySchema = z.object({
  platform: z.enum(PLATFORM),
  teamId: z.string(),
  userId: z.string(),
});

const serializedThreadShape = z.looseObject({
  _type: z.literal('chat:Thread'),
  adapterName: z.string(),
  channelId: z.string(),
  id: z.string(),
  isDM: z.boolean(),
});

const serializedThreadSchema = z.custom<SerializedThread>(
  value => serializedThreadShape.safeParse(value).success
);

const serializedMessageShape = z.looseObject({
  _type: z.literal('chat:Message'),
  attachments: z.array(z.unknown()),
  author: z.object({
    userId: z.string(),
    userName: z.string(),
    fullName: z.string(),
    isBot: z.union([z.boolean(), z.literal('unknown')]),
    isMe: z.boolean(),
  }),
  formatted: z.unknown(),
  id: z.string(),
  metadata: z.object({
    dateSent: z.iso.datetime(),
    edited: z.boolean(),
    editedAt: z.iso.datetime().optional(),
  }),
  raw: z.unknown(),
  text: z.string(),
  threadId: z.string(),
});

const serializedMessageSchema = z.custom<SerializedMessage>(
  value => serializedMessageShape.safeParse(value).success
);

const linkTokenPayloadSchema = z.object({
  identity: platformIdentitySchema,
  contextKey: z.string(),
  iat: z.number(),
  nonce: z.string().min(1),
});

const linkAccountContextSchema = z.object({
  thread: serializedThreadSchema,
  message: serializedMessageSchema,
});

function hmacSign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

/** Create a signed, time-limited token encoding a PlatformIdentity. */
function createLinkToken(payload: LinkTokenPayload): string {
  const iat = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify({ ...payload, iat, nonce })).toString(
    'base64url'
  );
  return `${encodedPayload}.${hmacSign(encodedPayload)}`;
}

export async function createLinkAccountToken({
  identity,
  thread,
  message,
  state,
}: LinkAccountContext & {
  identity: PlatformIdentity;
  state: StateAdapter;
}): Promise<string> {
  const contextKey = `${LINK_ACCOUNT_CONTEXT_KEY_PREFIX}${crypto.randomBytes(NONCE_BYTES).toString('base64url')}`;
  await state.set<LinkAccountContext>(contextKey, { thread, message }, LINK_ACCOUNT_CONTEXT_TTL_MS);
  return createLinkToken({ identity, contextKey });
}

export async function consumeLinkAccountContext(
  state: StateAdapter,
  contextKey: string
): Promise<boolean> {
  const consumedKey = `${contextKey}:consumed`;
  return await state.setIfNotExists(consumedKey, true, LINK_ACCOUNT_CONTEXT_TTL_MS);
}

/** Verify and decode a link token. Returns the payload or `null` on failure. */
export async function verifyLinkToken(
  state: StateAdapter,
  token: string
): Promise<VerifiedLinkToken | null> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;

  const payload = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);

  const expectedSig = hmacSign(payload);
  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const data = linkTokenPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    );
    const age = Math.floor(Date.now() / 1000) - data.iat;
    if (age < 0 || age > TOKEN_TTL_SECONDS) return null;

    const context = await state.get<unknown>(data.contextKey);
    const linkAccountContext = linkAccountContextSchema.parse(context);

    return {
      contextKey: data.contextKey,
      identity: data.identity,
      thread: linkAccountContext.thread,
      message: linkAccountContext.message,
    };
  } catch {
    return null;
  }
}
