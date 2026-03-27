/**
 * Lightweight Stream Chat server-side client for Cloudflare Workers.
 *
 * Uses fetch + jose for token generation. Does NOT depend on the `stream-chat`
 * npm package which requires Node.js APIs incompatible with CF Workers.
 *
 * Stream Chat REST API base: https://chat.stream-io-api.com
 * Auth: api_key query param + Authorization: <server_jwt> header
 */
import { SignJWT } from 'jose';

const STREAM_CHAT_API_BASE = 'https://chat.stream-io-api.com';

/**
 * Result of provisioning a Stream Chat default channel for a new KiloClaw instance.
 * Does NOT include a human user token — those are minted on demand with a short TTL
 * via {@link createShortLivedUserToken}.
 */
export type StreamChatSetup = {
  apiKey: string;
  /** Bot user ID: `bot-{sandboxId}` */
  botUserId: string;
  /** Permanent JWT for the bot user (used by the openclaw-channel-streamchat plugin) */
  botUserToken: string;
  /** Default channel ID: `default-{sandboxId}` */
  channelId: string;
};

/**
 * Generate a Stream Chat server-side JWT.
 * Used for admin operations (creating users, channels) from the CF Worker.
 * Payload: `{ server: true }` — gives full API access.
 */
export async function createServerToken(apiSecret: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(apiSecret);
  return new SignJWT({ server: true }).setProtectedHeader({ alg: 'HS256' }).sign(secretBytes);
}

/**
 * Generate a permanent Stream Chat user JWT for bot authentication.
 * Payload: `{ user_id: userId }` — scoped to a single user, no expiry.
 * For human/browser tokens use {@link createShortLivedUserToken} instead.
 */
export async function createUserToken(apiSecret: string, userId: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(apiSecret);
  return new SignJWT({ user_id: userId }).setProtectedHeader({ alg: 'HS256' }).sign(secretBytes);
}

/** Default TTL for browser-facing Stream Chat user tokens. */
export const USER_TOKEN_TTL = '6h';

/**
 * Generate a short-lived Stream Chat user JWT for browser authentication.
 * Payload: `{ user_id: userId }` with `iat` and `exp` claims.
 * The token expires after {@link USER_TOKEN_TTL} so that revoked users lose
 * access without requiring an app-secret rotation.
 */
export async function createShortLivedUserToken(
  apiSecret: string,
  userId: string
): Promise<string> {
  const secretBytes = new TextEncoder().encode(apiSecret);
  return new SignJWT({ user_id: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(USER_TOKEN_TTL)
    .sign(secretBytes);
}

/**
 * Upsert one or more Stream Chat users via the server API.
 * Creates the user if it doesn't exist; updates fields if it does.
 */
export async function upsertStreamChatUsers(
  apiKey: string,
  serverToken: string,
  users: ReadonlyArray<{ id: string; name: string; role?: string }>
): Promise<void> {
  const usersMap: Record<string, { id: string; name: string; role?: string }> = {};
  for (const user of users) {
    usersMap[user.id] = user;
  }

  const res = await fetch(`${STREAM_CHAT_API_BASE}/users?api_key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stream-Auth-Type': 'jwt',
      Authorization: serverToken,
    },
    body: JSON.stringify({ users: usersMap }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Stream Chat upsertUsers failed (${res.status}): ${body}`);
  }
}

/**
 * Get or create a Stream Chat channel.
 * Idempotent: safe to call on an existing channel.
 */
export async function getOrCreateStreamChatChannel(
  apiKey: string,
  serverToken: string,
  channelType: string,
  channelId: string,
  data: { created_by_id: string; members: string[]; name?: string }
): Promise<void> {
  const res = await fetch(
    `${STREAM_CHAT_API_BASE}/channels/${channelType}/${channelId}/query?api_key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stream-Auth-Type': 'jwt',
        Authorization: serverToken,
      },
      body: JSON.stringify({ data }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Stream Chat getOrCreateChannel failed (${res.status}): ${body}`);
  }
}

/**
 * Deactivate one or more Stream Chat users via the server API.
 * Deactivated users cannot connect to Stream Chat or send/receive messages,
 * making any previously issued tokens useless.
 * Silently ignores 404 (user not found). Attempts all users before throwing
 * so that a transient failure for one user doesn't leave others active.
 */
export async function deactivateStreamChatUsers(
  apiKey: string,
  apiSecret: string,
  userIds: readonly string[]
): Promise<void> {
  const serverToken = await createServerToken(apiSecret);
  const errors: Error[] = [];
  for (const userId of userIds) {
    const res = await fetch(
      `${STREAM_CHAT_API_BASE}/api/v2/users/${encodeURIComponent(userId)}/deactivate?api_key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stream-Auth-Type': 'jwt',
          Authorization: serverToken,
        },
        body: JSON.stringify({}),
      }
    );
    // 404 = user never existed, safe to ignore
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '(unreadable)');
      errors.push(
        new Error(`Stream Chat deactivateUser failed for ${userId} (${res.status}): ${body}`)
      );
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Stream Chat deactivateUsers had failures');
  }
}

/**
 * Reactivate one or more previously deactivated Stream Chat users.
 * Called during re-provision to ensure users can connect again.
 * Silently ignores 404 (user not found). Attempts all users before throwing
 * so that a transient failure for one user doesn't leave others deactivated.
 */
export async function reactivateStreamChatUsers(
  apiKey: string,
  apiSecret: string,
  userIds: readonly string[]
): Promise<void> {
  const serverToken = await createServerToken(apiSecret);
  const errors: Error[] = [];
  for (const userId of userIds) {
    const res = await fetch(
      `${STREAM_CHAT_API_BASE}/api/v2/users/${encodeURIComponent(userId)}/reactivate?api_key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stream-Auth-Type': 'jwt',
          Authorization: serverToken,
        },
        body: JSON.stringify({}),
      }
    );
    // 404 = user never existed, safe to ignore
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '(unreadable)');
      errors.push(
        new Error(`Stream Chat reactivateUser failed for ${userId} (${res.status}): ${body}`)
      );
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Stream Chat reactivateUsers had failures');
  }
}

/**
 * Provision the default Stream Chat channel for a new KiloClaw instance.
 *
 * Creates (or re-uses if already existing):
 *  - A human user with ID `{sandboxId}`
 *  - A per-instance bot user with ID `bot-{sandboxId}`
 *  - A messaging channel `default-{sandboxId}` with both as members
 *
 * Returns tokens and IDs needed to configure the machine and optionally the browser client.
 */
export async function setupDefaultStreamChatChannel(
  apiKey: string,
  apiSecret: string,
  sandboxId: string
): Promise<StreamChatSetup> {
  const serverToken = await createServerToken(apiSecret);

  const humanUserId = sandboxId;
  const botUserId = `bot-${sandboxId}`;
  const channelId = `default-${sandboxId}`;

  // Reactivate users in case they were deactivated by a prior destroy.
  // This is a no-op for first-time provisioning (404s are silently ignored).
  await reactivateStreamChatUsers(apiKey, apiSecret, [humanUserId, botUserId]);

  // Create/upsert both users
  await upsertStreamChatUsers(apiKey, serverToken, [
    { id: humanUserId, name: 'User' },
    { id: botUserId, name: 'KiloClaw', role: 'admin' },
  ]);

  // Create the default channel with both members
  await getOrCreateStreamChatChannel(apiKey, serverToken, 'messaging', channelId, {
    created_by_id: humanUserId,
    members: [humanUserId, botUserId],
    name: 'KiloClaw',
  });

  // Generate a permanent token for the bot user only.
  // Human user tokens are minted on demand with a short TTL (see createShortLivedUserToken).
  const botUserToken = await createUserToken(apiSecret, botUserId);

  return { apiKey, botUserId, botUserToken, channelId };
}
