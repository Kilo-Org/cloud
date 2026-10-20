import { z } from 'zod';

import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { REMOTE_MCP_OAUTH_KEY } from '@/lib/storage-keys';

/**
 * The OAuth state of each remote MCP server, on the account-scoped secure store
 * and cleared with it on sign-out.
 *
 * An entry names the URL it was made for. A server whose URL changed reads no
 * state, so a token issued for one endpoint is never sent to another.
 */

const tokensSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    id_token: z.string().optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
  })
  .strip();

const clientSchema = z
  .object({
    client_id: z.string(),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
    token_endpoint_auth_method: z.string().optional(),
  })
  .strip();

const oauthStateSchema = z
  .object({
    url: z.string(),
    tokens: tokensSchema.optional(),
    client: clientSchema.optional(),
    verifier: z.string().optional(),
  })
  .strip();

export type RemoteMcpOAuthState = z.infer<typeof oauthStateSchema>;

/** One unreadable entry reads as null alone, so it cannot sign every other server out. */
const oauthStatesSchema = z.record(
  z.string(),
  z.unknown().transform(entry => oauthStateSchema.safeParse(entry).data ?? null)
);

type OAuthStates = Readonly<z.infer<typeof oauthStatesSchema>>;

function parseOAuthStates(raw: string | null): OAuthStates {
  if (raw === null) {
    return {};
  }
  try {
    const parsed = oauthStatesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

const store = createSecureStorePreference<OAuthStates>({
  key: REMOTE_MCP_OAUTH_KEY,
  defaultValue: {},
  parse: parseOAuthStates,
  serialize: value => JSON.stringify(value),
  mergeOnLoad: (disk, pending) => ({ ...disk, ...pending }),
});

/** The state saved for this server at this URL, once the disk has been read. */
export async function readRemoteMcpOAuth(
  id: string,
  url: string
): Promise<RemoteMcpOAuthState | undefined> {
  await store.whenLoaded();
  const state = store.getRequested()[id];
  return state?.url === url ? state : undefined;
}

/**
 * Merges fields into this server's state. State saved for another URL is
 * replaced. The epoch check, the read and the write run in one synchronous
 * step after the disk read, so neither a concurrent write nor a sign-out can
 * land between them.
 */
export async function writeRemoteMcpOAuth(
  owner: { readonly id: string; readonly url: string; readonly epoch: number },
  patch: Omit<Partial<RemoteMcpOAuthState>, 'url'>
): Promise<void> {
  await store.whenLoaded();
  if (!isCurrentAuthEpoch(owner.epoch)) {
    return;
  }
  const { id, url } = owner;
  const current = store.getRequested();
  const existing = current[id]?.url === url ? current[id] : undefined;
  store.set({ ...current, [id]: { ...existing, ...patch, url } });
}

/** Drops one server's state, which is what deleting the server or changing its URL does. */
export async function forgetRemoteMcpOAuth(id: string): Promise<void> {
  await store.whenLoaded();
  const { [id]: forgotten, ...rest } = store.getRequested();
  if (forgotten !== undefined) {
    store.set(rest);
  }
}

/** Drops every server's state from memory and disk, which is what signing out does. */
export function clearRemoteMcpOAuth(): void {
  store.clear();
}
