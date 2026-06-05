import { z } from 'zod';
import { GatewayProviderGrantStatus, ProviderTokenResponseSchema } from '@kilocode/mcp-gateway';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import { getWorkerDb } from '@kilocode/db/client';
import {
  mcp_gateway_audit_events,
  mcp_gateway_connection_instances,
  mcp_gateway_configs,
  mcp_gateway_provider_grants,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { MCPGatewayEnv } from '../../types';
import { decryptProviderGrant } from '../../lib/credentials';
import { validateResolvedPublicUrl } from '../../lib/url-policy';
import { MCPGatewayInstanceStateRecord, mcpGatewayInstanceState } from './state.table';

export const RefreshProviderGrantInputSchema = z.object({
  instanceKey: z.string().min(1),
  instanceId: z.string().uuid(),
  grantId: z.string().uuid(),
  expectedGrantVersion: z.number().int().positive(),
  encryptedGrant: z.string().min(1),
  tokenEndpoint: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});

const credentialKeysetSchema = z.object({
  active: z.object({ keyId: z.string().min(1), publicKeyPem: z.string().min(1) }),
  decrypt: z
    .array(z.object({ keyId: z.string().min(1), privateKeyPem: z.string().min(1).optional() }))
    .default([]),
});

const grantScheme = 'mcp-gateway-provider-grant-rsa-aes-256-gcm';
const maxProviderResponseBytes = 128 * 1024;
const providerResponseChunkSchema = z.union([
  z.object({ done: z.literal(true), value: z.unknown().optional() }),
  z.object({ done: z.literal(false), value: z.instanceof(Uint8Array) }),
]);

function providerGrantAad(instanceId: string): string {
  return `mcp-gateway:instance:${instanceId}:provider-grant`;
}

async function readCappedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Provider response is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';
  while (true) {
    const rawChunk: unknown = await reader.read();
    const chunk = providerResponseChunkSchema.parse(rawChunk);
    if (chunk.done) break;
    const value = chunk.value;
    totalBytes += value.byteLength;
    if (totalBytes > maxProviderResponseBytes) {
      throw new Error('Provider response is too large');
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body);
}

function requireBearerTokenType(tokenResponse: z.infer<typeof ProviderTokenResponseSchema>) {
  if (!tokenResponse.token_type || tokenResponse.token_type.toLowerCase() !== 'bearer') {
    throw new Error('Provider token type is not supported');
  }
}

function activeCredentialKey(env: MCPGatewayEnv['Bindings']) {
  const serialized = env.MCP_GATEWAY_CREDENTIAL_KEYSET_JSON;
  if (!serialized) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  return credentialKeysetSchema.safeParse(parsed);
}

async function recordRefreshAudit(
  db: ReturnType<typeof getWorkerDb>,
  instanceId: string,
  outcome: 'success' | 'failure'
) {
  const rows = await db
    .select({ instance: mcp_gateway_connection_instances, config: mcp_gateway_configs })
    .from(mcp_gateway_connection_instances)
    .innerJoin(
      mcp_gateway_configs,
      eq(mcp_gateway_configs.config_id, mcp_gateway_connection_instances.config_id)
    )
    .where(eq(mcp_gateway_connection_instances.instance_id, instanceId))
    .limit(1);
  const resolved = rows[0];
  if (!resolved) return;
  await db.insert(mcp_gateway_audit_events).values({
    actor_kilo_user_id: resolved.instance.kilo_user_id,
    owner_scope: resolved.config.owner_scope,
    owner_id: resolved.config.owner_id,
    config_id: resolved.config.config_id,
    instance_id: resolved.instance.instance_id,
    event_type: 'provider_refresh',
    outcome,
    correlation_metadata: {},
  });
}

type MCPGatewayInstanceSQLite = DrizzleSqliteDODatabase<{
  mcpGatewayInstanceState: typeof mcpGatewayInstanceState;
}>;

export async function refreshProviderGrant(params: {
  env: MCPGatewayEnv['Bindings'];
  sqlite: MCPGatewayInstanceSQLite;
  input: unknown;
}) {
  const input = RefreshProviderGrantInputSchema.parse(params.input);
  const db = getWorkerDb(params.env.HYPERDRIVE.connectionString, { statement_timeout: 5_000 });
  const rows = await db
    .select()
    .from(mcp_gateway_provider_grants)
    .where(
      and(
        eq(mcp_gateway_provider_grants.provider_grant_id, input.grantId),
        eq(mcp_gateway_provider_grants.instance_id, input.instanceId),
        eq(mcp_gateway_provider_grants.grant_status, GatewayProviderGrantStatus.Active)
      )
    )
    .limit(1);
  const grant = rows[0];
  if (!grant || grant.grant_version !== input.expectedGrantVersion) {
    return { status: 'conflict' as const };
  }

  const refreshStartedAt = new Date().toISOString();

  await params.sqlite
    .insert(mcpGatewayInstanceState)
    .values({
      instanceKey: input.instanceKey,
      grantVersion: grant.grant_version,
      refreshStartedAt,
      refreshFailedAt: null,
      updatedAt: refreshStartedAt,
    })
    .onConflictDoUpdate({
      target: mcpGatewayInstanceState.instanceKey,
      set: {
        grantVersion: grant.grant_version,
        refreshStartedAt,
        refreshFailedAt: null,
        updatedAt: refreshStartedAt,
      },
    });

  try {
    const bundle = await decryptProviderGrant({
      env: params.env,
      instanceId: input.instanceId,
      encryptedGrant: grant.encrypted_grant,
    });
    if (!bundle.refreshToken) {
      throw new Error('Provider grant does not contain a refresh token');
    }
    const tokenEndpoint = await validateResolvedPublicUrl(input.tokenEndpoint, fetch);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
      client_id: input.clientId,
    });
    if (input.clientSecret) body.set('client_secret', input.clientSecret);
    const response = await fetch(tokenEndpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      redirect: 'manual',
    });
    if (!response.ok) {
      throw new Error('Provider refresh failed');
    }
    const tokenResponse = ProviderTokenResponseSchema.parse(await readCappedJson(response));
    requireBearerTokenType(tokenResponse);
    const tokenType = tokenResponse.token_type;
    if (!tokenType) {
      throw new Error('Provider token type is not supported');
    }
    const expiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : null;
    const keyset = activeCredentialKey(params.env);
    if (!keyset || !keyset.success) {
      throw new Error('Credential keyset is unavailable');
    }
    const encryptedGrant = encryptKeyedEnvelope(
      JSON.stringify({
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? bundle.refreshToken,
        expiresAt,
        scope: tokenResponse.scope ?? bundle.scope,
        tokenType,
      }),
      grantScheme,
      keyset.data.active,
      providerGrantAad(input.instanceId)
    );
    const updated = await db
      .update(mcp_gateway_provider_grants)
      .set({
        encrypted_grant: encryptedGrant,
        expires_at: expiresAt,
        grant_version: sql`${mcp_gateway_provider_grants.grant_version} + 1`,
      })
      .where(
        and(
          eq(mcp_gateway_provider_grants.provider_grant_id, input.grantId),
          eq(mcp_gateway_provider_grants.grant_version, input.expectedGrantVersion),
          eq(mcp_gateway_provider_grants.grant_status, GatewayProviderGrantStatus.Active)
        )
      )
      .returning({ grantVersion: mcp_gateway_provider_grants.grant_version });
    if (updated.length === 0) {
      return { status: 'conflict' as const };
    }
    const refreshedAt = new Date().toISOString();
    await params.sqlite
      .update(mcpGatewayInstanceState)
      .set({
        grantVersion: input.expectedGrantVersion + 1,
        refreshStartedAt: null,
        updatedAt: refreshedAt,
      })
      .where(eq(mcpGatewayInstanceState.instanceKey, input.instanceKey));
    await recordRefreshAudit(db, input.instanceId, 'success');
    return { status: 'refreshed' as const, grantVersion: input.expectedGrantVersion + 1 };
  } catch {
    await markRefreshFailure(
      db,
      params.sqlite,
      input.instanceId,
      input.instanceKey,
      input.grantId,
      input.expectedGrantVersion
    );
    await recordRefreshAudit(db, input.instanceId, 'failure');
    return { status: 'failed' as const };
  }
}

async function markRefreshFailure(
  db: ReturnType<typeof getWorkerDb>,
  sqlite: MCPGatewayInstanceSQLite,
  instanceId: string,
  instanceKey: string,
  grantId: string,
  expectedGrantVersion: number
) {
  await db
    .update(mcp_gateway_connection_instances)
    .set({
      instance_status: 'needs_reauth',
      instance_version: sql`${mcp_gateway_connection_instances.instance_version} + 1`,
    })
    .where(
      and(
        eq(mcp_gateway_connection_instances.instance_id, instanceId),
        eq(mcp_gateway_connection_instances.instance_status, 'active'),
        sql`exists (
          select 1 from ${mcp_gateway_provider_grants}
          where ${mcp_gateway_provider_grants.provider_grant_id} = ${grantId}
            and ${mcp_gateway_provider_grants.grant_version} = ${expectedGrantVersion}
            and ${mcp_gateway_provider_grants.grant_status} = 'active'
        )`
      )
    );
  const failedAt = new Date().toISOString();
  await sqlite
    .update(mcpGatewayInstanceState)
    .set({ refreshFailedAt: failedAt, updatedAt: failedAt })
    .where(eq(mcpGatewayInstanceState.instanceKey, instanceKey));
  const rows = await sqlite
    .select()
    .from(mcpGatewayInstanceState)
    .where(eq(mcpGatewayInstanceState.instanceKey, instanceKey))
    .limit(1);
  if (rows[0]) {
    MCPGatewayInstanceStateRecord.parse(rows[0]);
  }
}
