import { z } from 'zod';
import type {
  RemoteMcpAuth,
  RemoteMcpCachedTool,
  RemoteMcpServer,
  RemoteMcpStore,
} from './remote-mcp';
import { normalizeRemoteMcpUrl } from './remote-mcp-url';

export const REMOTE_MCP_STORAGE_KEY = 'local:kiloRemoteMcpServers';

type MaybePromise<Value> = Promise<Value> | Value;

export interface RemoteMcpStorageArea {
  getItem(key: typeof REMOTE_MCP_STORAGE_KEY): MaybePromise<unknown>;
  setItem(key: typeof REMOTE_MCP_STORAGE_KEY, value: RemoteMcpStore): MaybePromise<void>;
}

export type RemoteMcpServerDraft = Pick<
  RemoteMcpServer,
  'allowInSafeMode' | 'auth' | 'displayName' | 'enabled' | 'url'
> &
  Partial<
    Pick<
      RemoteMcpServer,
      'cachedTools' | 'id' | 'lastConnectedAt' | 'lastError' | 'slug' | 'status'
    >
  >;

const nonEmptyStringSchema = z.string().min(1);
// SDK OAuthClientInformation: client_id is required; other fields are optional.
const oauthClientInformationSchema = z
  .object({
    client_id: nonEmptyStringSchema,
    client_id_issued_at: z.number().optional(),
    client_secret: nonEmptyStringSchema.optional(),
    client_secret_expires_at: z.number().optional(),
  })
  .loose();
// SDK OAuthTokens: access_token and token_type are required.
const oauthTokensSchema = z
  .object({
    access_token: nonEmptyStringSchema,
    expires_in: z.number().optional(),
    id_token: nonEmptyStringSchema.optional(),
    refresh_token: nonEmptyStringSchema.optional(),
    scope: nonEmptyStringSchema.optional(),
    token_type: nonEmptyStringSchema,
  })
  .loose();
const oauthStateSchema = z
  .object({
    clientInformation: oauthClientInformationSchema.optional(),
    codeVerifier: nonEmptyStringSchema.optional(),
    tokens: oauthTokensSchema.optional(),
  })
  .strip();
const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strip(),
  z.object({ token: nonEmptyStringSchema.optional(), type: z.literal('bearer') }).strip(),
  z
    .object({
      headerName: nonEmptyStringSchema,
      headerValue: nonEmptyStringSchema.optional(),
      type: z.literal('header'),
    })
    .strip(),
  z.object({ oauth: z.unknown().optional(), type: z.literal('oauth') }).strip(),
]);
const cachedToolSchema = z
  .object({
    description: nonEmptyStringSchema.optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    name: nonEmptyStringSchema,
  })
  .strip();
const statusSchema = z.enum(['connected', 'needs_auth', 'unavailable', 'untested']);
const serverSchema = z
  .object({
    allowInSafeMode: z.boolean(),
    auth: authSchema,
    cachedTools: z.array(cachedToolSchema),
    displayName: nonEmptyStringSchema,
    enabled: z.boolean(),
    id: nonEmptyStringSchema,
    lastConnectedAt: nonEmptyStringSchema.optional(),
    lastError: nonEmptyStringSchema.optional(),
    slug: nonEmptyStringSchema,
    status: statusSchema,
    url: nonEmptyStringSchema,
  })
  .strip();
const storeSchema = z.object({ servers: z.array(z.unknown()) }).strip();

const toRemoteMcpAuth = (auth: z.infer<typeof authSchema>): RemoteMcpAuth => {
  switch (auth.type) {
    case 'bearer': {
      return auth.token === undefined ? { type: 'bearer' } : { token: auth.token, type: 'bearer' };
    }
    case 'header': {
      return auth.headerValue === undefined
        ? { headerName: auth.headerName, type: 'header' }
        : { headerName: auth.headerName, headerValue: auth.headerValue, type: 'header' };
    }
    case 'oauth': {
      /*
       * Malformed persisted OAuth state degrades to "no oauth state" rather than
       * dropping the whole server, matching the normalize-drops-bad-entries behavior.
       */
      const parsedOauth = oauthStateSchema.safeParse(auth.oauth);
      return parsedOauth.success && auth.oauth !== undefined
        ? { oauth: parsedOauth.data, type: 'oauth' }
        : { type: 'oauth' };
    }
    case 'none': {
      return auth;
    }
  }
};

const toRemoteMcpCachedTool = (tool: z.infer<typeof cachedToolSchema>): RemoteMcpCachedTool => ({
  inputSchema: tool.inputSchema,
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
});

const normalizeStoredUrl = (url: string): string | undefined => {
  try {
    return normalizeRemoteMcpUrl(url);
  } catch {
    return undefined;
  }
};

const toRemoteMcpServer = (server: z.infer<typeof serverSchema>): RemoteMcpServer | undefined => {
  const url = normalizeStoredUrl(server.url);

  if (url === undefined) {
    return undefined;
  }

  return {
    allowInSafeMode: server.allowInSafeMode,
    auth: toRemoteMcpAuth(server.auth),
    cachedTools: server.cachedTools.map(toRemoteMcpCachedTool),
    displayName: server.displayName,
    enabled: server.enabled,
    id: server.id,
    slug: server.slug,
    status: server.status,
    url,
    ...(server.lastConnectedAt === undefined ? {} : { lastConnectedAt: server.lastConnectedAt }),
    ...(server.lastError === undefined ? {} : { lastError: server.lastError }),
  };
};

export const normalizeRemoteMcpStore = (value: unknown): RemoteMcpStore => {
  const parsed = storeSchema.safeParse(value);

  if (!parsed.success) {
    return { servers: [] };
  }

  const urls = new Set<string>();

  return {
    servers: parsed.data.servers.flatMap(server => {
      const parsedServer = serverSchema.safeParse(server);
      if (!parsedServer.success) {
        return [];
      }

      const normalizedServer = toRemoteMcpServer(parsedServer.data);
      if (normalizedServer === undefined || urls.has(normalizedServer.url)) {
        return [];
      }

      urls.add(normalizedServer.url);
      return [normalizedServer];
    }),
  };
};

export const loadRemoteMcpStore = async (
  storageArea: RemoteMcpStorageArea
): Promise<RemoteMcpStore> =>
  normalizeRemoteMcpStore(await storageArea.getItem(REMOTE_MCP_STORAGE_KEY));

export const saveRemoteMcpStore = async (
  storageArea: RemoteMcpStorageArea,
  store: RemoteMcpStore
): Promise<void> => {
  await storageArea.setItem(REMOTE_MCP_STORAGE_KEY, normalizeRemoteMcpStore(store));
};

const createId = (): string => crypto.randomUUID();

const createSlug = (displayName: string): string => {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : 'remote-mcp';
};

// Uniquify the slug: servers sharing one map their tools to the same name and silently drop each other.
const createUniqueSlug = (displayName: string, servers: readonly RemoteMcpServer[]): string => {
  const base = createSlug(displayName);
  const taken = new Set(servers.map(server => server.slug));
  if (!taken.has(base)) {
    return base;
  }

  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
};

const authChanged = (existing: RemoteMcpAuth, draft: RemoteMcpAuth): boolean => {
  switch (draft.type) {
    case 'bearer': {
      if (existing.type !== 'bearer') {
        return true;
      }

      return existing.token !== draft.token;
    }
    case 'header': {
      if (existing.type !== 'header') {
        return true;
      }

      return existing.headerName !== draft.headerName || existing.headerValue !== draft.headerValue;
    }
    case 'oauth': {
      return existing.type !== 'oauth';
    }
    case 'none': {
      return existing.type !== 'none';
    }
  }
};

export const upsertRemoteMcpServer = (
  store: RemoteMcpStore,
  draft: RemoteMcpServerDraft
): RemoteMcpStore => {
  const { servers } = normalizeRemoteMcpStore(store);
  const url = normalizeRemoteMcpUrl(draft.url);
  const existingIndex =
    draft.id === undefined ? -1 : servers.findIndex(server => server.id === draft.id);
  const existing = existingIndex === -1 ? undefined : servers[existingIndex];

  if (servers.some(server => server.url === url && server.id !== existing?.id)) {
    throw new Error('Remote MCP URL is already saved.');
  }

  const connectionChanged =
    existing !== undefined && (existing.url !== url || authChanged(existing.auth, draft.auth));
  const server: RemoteMcpServer = {
    allowInSafeMode: draft.allowInSafeMode,
    auth: draft.auth,
    cachedTools: connectionChanged ? [] : (draft.cachedTools ?? existing?.cachedTools ?? []),
    displayName: draft.displayName,
    enabled: draft.enabled,
    id: existing?.id ?? draft.id ?? createId(),
    lastConnectedAt: connectionChanged
      ? undefined
      : (draft.lastConnectedAt ?? existing?.lastConnectedAt),
    lastError: connectionChanged ? undefined : (draft.lastError ?? existing?.lastError),
    slug: existing?.slug ?? draft.slug ?? createUniqueSlug(draft.displayName, servers),
    status: connectionChanged ? 'untested' : (draft.status ?? existing?.status ?? 'untested'),
    url,
  };

  return {
    servers:
      existingIndex === -1
        ? [...servers, server]
        : servers.map((current, index) => (index === existingIndex ? server : current)),
  };
};
