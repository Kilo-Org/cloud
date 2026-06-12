import {
  ConfigSecretBundleSchema,
  GatewaySecretKind,
  parseStaticHeaders,
  ProviderGrantBundleSchema,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import { decryptKeyedEnvelope, type EnvelopePrivateKeySlots } from '@kilocode/encryption';
import { z } from 'zod';
import type { MCPGatewayEnv } from '../types';

const secretScheme = 'mcp-gateway-credential-rsa-aes-256-gcm';
const grantScheme = 'mcp-gateway-provider-grant-rsa-aes-256-gcm';

const CredentialKeysetSchema = z.object({
  active: z.object({ keyId: z.string().min(1), privateKeyPem: z.string().min(1).optional() }),
  decrypt: z
    .array(z.object({ keyId: z.string().min(1), privateKeyPem: z.string().min(1).optional() }))
    .default([]),
});

const StaticHeadersSchema = z.object({ headers: z.record(z.string(), z.string().min(1)) });
const ProviderCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});

function configSecretAad(configId: string, kind: string): string {
  return `mcp-gateway:config:${configId}:secret:${kind}`;
}

function providerGrantAad(instanceId: string): string {
  return `mcp-gateway:instance:${instanceId}:provider-grant`;
}

async function credentialKeyset(env: MCPGatewayEnv['Bindings']): Promise<EnvelopePrivateKeySlots> {
  const serialized = env.MCP_GATEWAY_CREDENTIAL_KEYSET_JSON;
  if (!serialized) {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Credential keyset is unavailable', 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Credential keyset is malformed', 500);
  }
  return CredentialKeysetSchema.parse(parsed);
}

export async function decryptConfigSecret(params: {
  env: MCPGatewayEnv['Bindings'];
  configId: string;
  kind: string;
  encryptedSecret: string;
}) {
  const keyset = await credentialKeyset(params.env);
  const decrypted = decryptKeyedEnvelope(
    params.encryptedSecret,
    secretScheme,
    keyset,
    configSecretAad(params.configId, params.kind)
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Config secret is malformed', 500);
  }
  return ConfigSecretBundleSchema.parse(parsed);
}

export async function loadStaticHeaders(params: {
  env: MCPGatewayEnv['Bindings'];
  configId: string;
  encryptedSecret: string;
}) {
  const secret = await decryptConfigSecret({
    env: params.env,
    configId: params.configId,
    kind: GatewaySecretKind.StaticHeaders,
    encryptedSecret: params.encryptedSecret,
  });
  if (secret.kind !== GatewaySecretKind.StaticHeaders) {
    throw createGatewayError(
      GatewayErrorCode.ServerError,
      'Static header secret kind mismatch',
      500
    );
  }
  return parseStaticHeaders(StaticHeadersSchema.parse(secret.value).headers);
}

export async function loadProviderCredentials(params: {
  env: MCPGatewayEnv['Bindings'];
  configId: string;
  kind:
    | typeof GatewaySecretKind.DynamicRegistration
    | typeof GatewaySecretKind.StaticProviderCredentials;
  encryptedSecret: string;
}) {
  const secret = await decryptConfigSecret({
    env: params.env,
    configId: params.configId,
    kind: params.kind,
    encryptedSecret: params.encryptedSecret,
  });
  if (secret.kind !== params.kind) {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Provider secret kind mismatch', 500);
  }
  return ProviderCredentialsSchema.parse(secret.value);
}

export async function decryptProviderGrant(params: {
  env: MCPGatewayEnv['Bindings'];
  instanceId: string;
  encryptedGrant: string;
}) {
  const keyset = await credentialKeyset(params.env);
  const decrypted = decryptKeyedEnvelope(
    params.encryptedGrant,
    grantScheme,
    keyset,
    providerGrantAad(params.instanceId)
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Provider grant is malformed', 500);
  }
  return ProviderGrantBundleSchema.parse(parsed);
}
