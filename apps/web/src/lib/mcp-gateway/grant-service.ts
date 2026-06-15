import 'server-only';
import {
  GatewayProviderGrantStatus,
  GatewayInstanceStatus,
  ProviderGrantBundleSchema,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import { decryptKeyedEnvelope, encryptKeyedEnvelope } from '@kilocode/encryption';
import { mcp_gateway_connection_instances, mcp_gateway_provider_grants } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { GatewayAppConfig } from './config';
import type { GatewayRepository } from './repository';
import { nowIso, providerGrantAad } from './crypto';

const grantScheme = 'mcp-gateway-provider-grant-rsa-aes-256-gcm';

export function createGrantService(params: {
  repository: GatewayRepository;
  config: GatewayAppConfig;
}) {
  function encryptGrant(bundle: unknown, instanceId: string): string {
    const parsed = ProviderGrantBundleSchema.parse(bundle);
    return encryptKeyedEnvelope(
      JSON.stringify(parsed),
      grantScheme,
      params.config.credentialKeyset.active,
      providerGrantAad(instanceId)
    );
  }

  function decryptGrant(encryptedGrant: string, instanceId: string) {
    const decrypted = decryptKeyedEnvelope(
      encryptedGrant,
      grantScheme,
      params.config.credentialKeyset,
      providerGrantAad(instanceId)
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw createGatewayError(
        GatewayErrorCode.ServerError,
        'Stored provider grant is malformed',
        500
      );
    }
    return ProviderGrantBundleSchema.parse(parsed);
  }

  async function replaceGrant(paramsInput: {
    instanceId: string;
    bundle: unknown;
    providerSubject?: string | null;
  }) {
    const encryptedGrant = encryptGrant(paramsInput.bundle, paramsInput.instanceId);
    return await params.repository.database.transaction(async tx => {
      const [instance] = await tx
        .select()
        .from(mcp_gateway_connection_instances)
        .where(eq(mcp_gateway_connection_instances.instance_id, paramsInput.instanceId))
        .limit(1);
      if (
        !instance ||
        instance.instance_status === GatewayInstanceStatus.Removed ||
        instance.instance_status === GatewayInstanceStatus.Revoked
      ) {
        throw createGatewayError(
          GatewayErrorCode.AccessDenied,
          'Connection instance is unavailable',
          403
        );
      }
      const [latestGrant] = await tx
        .select()
        .from(mcp_gateway_provider_grants)
        .where(eq(mcp_gateway_provider_grants.instance_id, paramsInput.instanceId))
        .orderBy(sql`${mcp_gateway_provider_grants.grant_version} desc`)
        .limit(1);
      const [activeGrant] = await tx
        .select()
        .from(mcp_gateway_provider_grants)
        .where(
          and(
            eq(mcp_gateway_provider_grants.instance_id, paramsInput.instanceId),
            eq(mcp_gateway_provider_grants.grant_status, GatewayProviderGrantStatus.Active)
          )
        )
        .limit(1);
      const latestGrantVersion = latestGrant?.grant_version ?? 0;
      const revokedGrantVersion = activeGrant ? latestGrantVersion + 1 : null;
      const nextGrantVersion = activeGrant ? latestGrantVersion + 2 : latestGrantVersion + 1;
      if (instance.instance_status === GatewayInstanceStatus.NeedsReauth) {
        await tx
          .update(mcp_gateway_connection_instances)
          .set({
            instance_status: GatewayInstanceStatus.Active,
            instance_version: sql`${mcp_gateway_connection_instances.instance_version} + 1`,
          })
          .where(eq(mcp_gateway_connection_instances.instance_id, paramsInput.instanceId));
      }
      if (activeGrant && revokedGrantVersion) {
        await tx
          .update(mcp_gateway_provider_grants)
          .set({
            grant_status: GatewayProviderGrantStatus.Revoked,
            revoked_at: nowIso(),
            grant_version: revokedGrantVersion,
          })
          .where(eq(mcp_gateway_provider_grants.provider_grant_id, activeGrant.provider_grant_id));
      }
      const [grant] = await tx
        .insert(mcp_gateway_provider_grants)
        .values({
          instance_id: paramsInput.instanceId,
          encrypted_grant: encryptedGrant,
          provider_subject: paramsInput.providerSubject ?? null,
          grant_status: GatewayProviderGrantStatus.Active,
          grant_version: nextGrantVersion,
        })
        .returning();
      return grant;
    });
  }

  async function revokeGrant(instanceId: string) {
    const rows = await params.repository.database
      .update(mcp_gateway_provider_grants)
      .set({
        grant_status: GatewayProviderGrantStatus.Revoked,
        revoked_at: nowIso(),
        grant_version: sql`${mcp_gateway_provider_grants.grant_version} + 1`,
      })
      .where(
        and(
          eq(mcp_gateway_provider_grants.instance_id, instanceId),
          eq(mcp_gateway_provider_grants.grant_status, GatewayProviderGrantStatus.Active)
        )
      )
      .returning();
    return rows[0] ?? null;
  }

  return { encryptGrant, decryptGrant, replaceGrant, revokeGrant };
}

export type GatewayGrantService = ReturnType<typeof createGrantService>;
