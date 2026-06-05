import {
  GatewayAuthMode,
  GatewaySecretKind,
  ProviderAuthorizationServerMetadataSchema,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';
import type { RuntimeResolution } from '../db/runtime-repository';
import { findProviderSecret, resolveRuntimeState } from '../db/runtime-repository';
import { decryptProviderGrant, loadProviderCredentials } from './credentials';
import { getMCPGatewayInstanceStub } from '../durable-objects/MCPGatewayInstance.do';

function instanceKey(resolution: RuntimeResolution): string {
  return `${resolution.config.owner_scope}:${resolution.config.owner_id}:${resolution.config.config_id}:${resolution.user.id}`;
}

function grantExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + 30_000;
}

export async function resolveProviderAuthorization(params: {
  env: MCPGatewayEnv['Bindings'];
  resolution: RuntimeResolution;
  route: Parameters<typeof resolveRuntimeState>[0]['route'];
}) {
  const { resolution } = params;
  if (
    resolution.config.auth_mode !== GatewayAuthMode.OAuthDynamic &&
    resolution.config.auth_mode !== GatewayAuthMode.OAuthStatic
  ) {
    return null;
  }
  if (!resolution.grant) {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Provider grant is unavailable', 403);
  }
  let bundle = await decryptProviderGrant({
    env: params.env,
    instanceId: resolution.instance.instance_id,
    encryptedGrant: resolution.grant.encrypted_grant,
  });
  if (!bundle.tokenType || bundle.tokenType.toLowerCase() !== 'bearer') {
    throw createGatewayError(
      GatewayErrorCode.Forbidden,
      'Provider token type is not supported',
      403
    );
  }
  if (!grantExpired(bundle.expiresAt)) {
    return { providerAuthorization: `Bearer ${bundle.accessToken}`, resolution };
  }
  const metadata = ProviderAuthorizationServerMetadataSchema.safeParse(
    resolution.config.discovered_provider_metadata
  );
  if (!metadata.success) {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Provider metadata is unavailable', 500);
  }
  const secret = await findProviderSecret({
    env: params.env,
    configId: resolution.config.config_id,
    authMode: resolution.config.auth_mode,
  });
  if (!secret) {
    throw createGatewayError(
      GatewayErrorCode.Forbidden,
      'Provider credentials are unavailable',
      403
    );
  }
  const credentials = await loadProviderCredentials({
    env: params.env,
    configId: resolution.config.config_id,
    kind:
      resolution.config.auth_mode === GatewayAuthMode.OAuthDynamic
        ? GatewaySecretKind.DynamicRegistration
        : GatewaySecretKind.StaticProviderCredentials,
    encryptedSecret: secret.encrypted_secret,
  });
  const stub = getMCPGatewayInstanceStub(params.env, instanceKey(resolution));
  const refreshResult = await stub.refreshProviderGrant({
    instanceKey: instanceKey(resolution),
    instanceId: resolution.instance.instance_id,
    grantId: resolution.grant.provider_grant_id,
    expectedGrantVersion: resolution.grant.grant_version,
    encryptedGrant: resolution.grant.encrypted_grant,
    tokenEndpoint: metadata.data.token_endpoint,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });
  if (refreshResult.status !== 'refreshed' && refreshResult.status !== 'conflict') {
    throw createGatewayError(
      GatewayErrorCode.Forbidden,
      'Provider authorization needs renewal',
      403
    );
  }
  const reloaded = await resolveRuntimeState({
    env: params.env,
    route: params.route,
    userId: resolution.user.id,
  });
  if (!reloaded?.grant) {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Provider grant is unavailable', 403);
  }
  bundle = await decryptProviderGrant({
    env: params.env,
    instanceId: reloaded.instance.instance_id,
    encryptedGrant: reloaded.grant.encrypted_grant,
  });
  if (!bundle.tokenType || bundle.tokenType.toLowerCase() !== 'bearer') {
    throw createGatewayError(
      GatewayErrorCode.Forbidden,
      'Provider token type is not supported',
      403
    );
  }
  if (grantExpired(bundle.expiresAt)) {
    throw createGatewayError(
      GatewayErrorCode.Forbidden,
      'Provider authorization needs renewal',
      403
    );
  }
  return { providerAuthorization: `Bearer ${bundle.accessToken}`, resolution: reloaded };
}
