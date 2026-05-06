import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_mcp_servers,
  type AgentEnvironmentProfileMcpServer,
} from '@kilocode/db/schema';
import { and, eq, count } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { encryptWithPublicKey, type EncryptedEnvelope } from '@kilocode/encryption';
import {
  MASKED_SECRET_VALUE,
  type McpServerConfigFragment,
  type ProfileMcpServerResponse,
  type ProfileOwner,
} from './types';
import { verifyProfileOwnership } from './profile-utils';

export const MAX_PROFILE_MCP_SERVERS = 20;
export const MAX_MCP_SERVER_NAME_LENGTH = 100;
export const MAX_MCP_ENV_OR_HEADERS = 50;

/** Zod-validated encrypted envelope (matches the shape stored in the DB). */
const encryptedEnvelopeSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

/** User-supplied local MCP config: env values are plaintext strings, encrypted at-rest on write. */
export const mcpLocalConfigInputSchema = z.object({
  command: z.array(z.string().max(500)).min(1).max(50),
  environment: z
    .record(z.string().max(128), z.string().max(4096))
    .refine(
      obj => Object.keys(obj).length <= MAX_MCP_ENV_OR_HEADERS,
      `Maximum ${MAX_MCP_ENV_OR_HEADERS} environment entries per MCP server`
    )
    .optional(),
});

export const mcpRemoteConfigInputSchema = z.object({
  url: z.string().url().max(2048),
  headers: z
    .record(z.string().max(128), z.string().max(4096))
    .refine(
      obj => Object.keys(obj).length <= MAX_MCP_ENV_OR_HEADERS,
      `Maximum ${MAX_MCP_ENV_OR_HEADERS} header entries per MCP server`
    )
    .optional(),
});

const mcpServerInputBase = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_MCP_SERVER_NAME_LENGTH)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only letters, numbers, underscores, and dashes'),
  enabled: z.boolean().optional(),
  timeout: z.number().int().min(1).max(3_600_000).optional(),
});

export const mcpLocalServerInputSchema = mcpServerInputBase.extend({
  type: z.literal('local'),
  config: mcpLocalConfigInputSchema,
});

export const mcpRemoteServerInputSchema = mcpServerInputBase.extend({
  type: z.literal('remote'),
  config: mcpRemoteConfigInputSchema,
});

export const mcpServerFullInputSchema = z.discriminatedUnion('type', [
  mcpLocalServerInputSchema,
  mcpRemoteServerInputSchema,
]);

export type McpServerInput = z.infer<typeof mcpServerFullInputSchema>;

/**
 * Marketplace MCP input (loose shape mirroring marketplace YAML).
 * `command` + `args` are joined and normalized into the CLI-native local shape.
 */
export const mcpMarketplaceInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_MCP_SERVER_NAME_LENGTH)
    .regex(/^[a-zA-Z0-9_-]+$/),
  enabled: z.boolean().optional(),
  timeout: z.number().int().min(1).max(3_600_000).optional(),
  // Local marketplace entry
  command: z.string().min(1).max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  environment: z.record(z.string().max(128), z.string().max(4096)).optional(),
  // Remote marketplace entry
  url: z.string().url().max(2048).optional(),
  headers: z.record(z.string().max(128), z.string().max(4096)).optional(),
});

export type McpMarketplaceInput = z.infer<typeof mcpMarketplaceInputSchema>;

/** Normalize a marketplace MCP entry into the CLI-native local/remote shape. */
export function normalizeMarketplaceMcp(input: McpMarketplaceInput): McpServerInput {
  if (input.url) {
    return {
      type: 'remote',
      name: input.name,
      enabled: input.enabled,
      timeout: input.timeout,
      config: {
        url: input.url,
        headers: input.headers,
      },
    };
  }
  if (input.command) {
    return {
      type: 'local',
      name: input.name,
      enabled: input.enabled,
      timeout: input.timeout,
      config: {
        command: [input.command, ...(input.args ?? [])],
        environment: input.environment,
      },
    };
  }
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Marketplace MCP entry must have either `url` (remote) or `command` (local)',
  });
}

/**
 * Shape persisted in the `agent_environment_profile_mcp_servers.config` jsonb.
 * Env/header values are always encrypted envelopes.
 */
type StoredMcpLocalConfig = {
  command: string[];
  environment?: Record<string, EncryptedEnvelope>;
};
type StoredMcpRemoteConfig = {
  url: string;
  headers?: Record<string, EncryptedEnvelope>;
};
type StoredMcpConfig = StoredMcpLocalConfig | StoredMcpRemoteConfig;

function encryptValue(publicKeyBase64: string, value: string): EncryptedEnvelope {
  if (!publicKeyBase64) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Agent environment encryption key not configured',
    });
  }
  const publicKey = Buffer.from(publicKeyBase64, 'base64');
  return encryptWithPublicKey(value, publicKey);
}

/**
 * Encrypt plaintext values, but reuse an existing encrypted envelope for any
 * key whose input value is exactly `MASKED_SECRET_VALUE`. This lets the edit
 * UI surface existing keys with the placeholder so the user can decide
 * per-key whether to rotate or keep the secret — a replace-everything
 * update would otherwise force re-entering all values.
 */
function encryptRecord(
  publicKeyBase64: string,
  values: Record<string, string> | undefined,
  existing?: Record<string, EncryptedEnvelope>
): Record<string, EncryptedEnvelope> | undefined {
  if (!values) return undefined;
  const out: Record<string, EncryptedEnvelope> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === MASKED_SECRET_VALUE && existing?.[key]) {
      out[key] = existing[key];
    } else {
      out[key] = encryptValue(publicKeyBase64, value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Convert user input → config shape with encrypted env/header values.
 * On update, `existing` carries the previously stored encrypted envelopes
 * so keys left as the masked placeholder round-trip unchanged.
 */
function buildStoredConfig(
  publicKeyBase64: string,
  input: McpServerInput,
  existing?: StoredMcpConfig
): StoredMcpConfig {
  if (input.type === 'local') {
    const existingEnv = existing && 'command' in existing ? existing.environment : undefined;
    return {
      command: input.config.command,
      environment: encryptRecord(publicKeyBase64, input.config.environment, existingEnv),
    };
  }
  const existingHeaders = existing && 'url' in existing ? existing.headers : undefined;
  return {
    url: input.config.url,
    headers: encryptRecord(publicKeyBase64, input.config.headers, existingHeaders),
  };
}

function maskValues(
  values: Record<string, EncryptedEnvelope> | undefined
): Record<string, string> | undefined {
  if (!values) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(values)) {
    out[key] = MASKED_SECRET_VALUE;
  }
  return out;
}

/**
 * Convert persisted (envelope-valued) config → sanitized response with values masked.
 */
function toMaskedConfig(
  type: 'local' | 'remote',
  config: StoredMcpConfig
): McpServerConfigFragment {
  if (type === 'local') {
    const c = config as StoredMcpLocalConfig;
    return {
      command: c.command,
      environment: maskValues(c.environment),
    };
  }
  const c = config as StoredMcpRemoteConfig;
  return {
    url: c.url,
    headers: maskValues(c.headers),
  };
}

async function assertMcpServerLimit(db: WorkerDb, profileId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(agent_environment_profile_mcp_servers)
    .where(eq(agent_environment_profile_mcp_servers.profile_id, profileId));
  if (Number(row.n) >= MAX_PROFILE_MCP_SERVERS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_MCP_SERVERS} MCP servers`,
    });
  }
}

async function fetchMcpServer(
  db: WorkerDb,
  mcpServerId: string,
  profileId: string
): Promise<AgentEnvironmentProfileMcpServer> {
  const [server] = await db
    .select()
    .from(agent_environment_profile_mcp_servers)
    .where(
      and(
        eq(agent_environment_profile_mcp_servers.id, mcpServerId),
        eq(agent_environment_profile_mcp_servers.profile_id, profileId)
      )
    )
    .limit(1);
  if (!server) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'MCP server not found' });
  }
  return server;
}

function toResponse(server: AgentEnvironmentProfileMcpServer): ProfileMcpServerResponse {
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    enabled: server.enabled,
    timeout: server.timeout,
    config: toMaskedConfig(server.type, server.config as StoredMcpConfig),
    createdAt: server.created_at,
    updatedAt: server.updated_at,
  };
}

/**
 * List all MCP servers for a profile.
 * Secret env/header values are masked in the response.
 * Internal: no ownership check; used by `profile-service.getProfile` which has already verified.
 */
export async function listMcpServersForProfile(
  db: WorkerDb,
  profileId: string
): Promise<ProfileMcpServerResponse[]> {
  const servers = await db
    .select()
    .from(agent_environment_profile_mcp_servers)
    .where(eq(agent_environment_profile_mcp_servers.profile_id, profileId))
    .orderBy(agent_environment_profile_mcp_servers.name);

  return servers.map(toResponse);
}

export async function createMcpServer(
  db: WorkerDb,
  publicKeyBase64: string,
  profileId: string,
  input: McpServerInput,
  owner: ProfileOwner
): Promise<{ id: string }> {
  await verifyProfileOwnership(db, profileId, owner);
  await assertMcpServerLimit(db, profileId);

  const config = buildStoredConfig(publicKeyBase64, input);

  const [server] = await db
    .insert(agent_environment_profile_mcp_servers)
    .values({
      profile_id: profileId,
      name: input.name,
      type: input.type,
      enabled: input.enabled ?? true,
      timeout: input.timeout ?? null,
      config,
    })
    .returning({ id: agent_environment_profile_mcp_servers.id });

  return { id: server.id };
}

export async function updateMcpServer(
  db: WorkerDb,
  publicKeyBase64: string,
  profileId: string,
  mcpServerId: string,
  input: McpServerInput,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  const existing = await fetchMcpServer(db, mcpServerId, profileId);

  const config = buildStoredConfig(publicKeyBase64, input, existing.config as StoredMcpConfig);

  await db
    .update(agent_environment_profile_mcp_servers)
    .set({
      name: input.name,
      type: input.type,
      enabled: input.enabled ?? true,
      timeout: input.timeout ?? null,
      config,
    })
    .where(eq(agent_environment_profile_mcp_servers.id, mcpServerId));
}

export async function deleteMcpServer(
  db: WorkerDb,
  profileId: string,
  mcpServerId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchMcpServer(db, mcpServerId, profileId);
  await db
    .delete(agent_environment_profile_mcp_servers)
    .where(eq(agent_environment_profile_mcp_servers.id, mcpServerId));
}

export async function setMcpEnabled(
  db: WorkerDb,
  profileId: string,
  mcpServerId: string,
  enabled: boolean,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchMcpServer(db, mcpServerId, profileId);
  await db
    .update(agent_environment_profile_mcp_servers)
    .set({ enabled })
    .where(eq(agent_environment_profile_mcp_servers.id, mcpServerId));
}

/**
 * Shape used for session materialization. Env/header values travel as
 * encrypted envelopes straight through the wire to the cloud-agent-next
 * worker, which decrypts per-value just before writing KILO_CONFIG_CONTENT.
 */
export type McpServerForSession = {
  name: string;
  type: 'local' | 'remote';
  enabled: boolean;
  timeout?: number;
  command?: string[];
  url?: string;
  /** Encrypted env values (local). */
  environment?: Record<string, EncryptedEnvelope>;
  /** Encrypted header values (remote). */
  headers?: Record<string, EncryptedEnvelope>;
};

/** Parse an envelope record from stored jsonb, dropping malformed entries. */
function parseEnvelopeRecord(raw: unknown): Record<string, EncryptedEnvelope> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, EncryptedEnvelope> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = encryptedEnvelopeSchema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Internal: load MCP servers (with encrypted envelopes intact) for session preparation.
 * No ownership check — the caller must have already verified.
 */
export async function getMcpServersForSession(
  db: WorkerDb,
  profileId: string
): Promise<McpServerForSession[]> {
  const servers = await db
    .select()
    .from(agent_environment_profile_mcp_servers)
    .where(eq(agent_environment_profile_mcp_servers.profile_id, profileId));

  return servers.map(server => {
    const config = server.config as StoredMcpConfig;
    if (server.type === 'local') {
      const c = config as StoredMcpLocalConfig;
      return {
        name: server.name,
        type: 'local' as const,
        enabled: server.enabled,
        timeout: server.timeout ?? undefined,
        command: c.command,
        environment: parseEnvelopeRecord(c.environment),
      };
    }
    const c = config as StoredMcpRemoteConfig;
    return {
      name: server.name,
      type: 'remote' as const,
      enabled: server.enabled,
      timeout: server.timeout ?? undefined,
      url: c.url,
      headers: parseEnvelopeRecord(c.headers),
    };
  });
}
