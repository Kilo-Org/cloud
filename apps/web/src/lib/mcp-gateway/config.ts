import 'server-only';
import { getEnvVariable } from '@/lib/dotenvx';
import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';

const JWTKeySchema = z.object({
  keyId: z.string().min(1),
  publicJwk: z.custom<JsonWebKey>(
    value => value !== null && typeof value === 'object',
    'publicJwk must be an object'
  ),
  privateKeyPem: z.string().min(1).optional(),
});

const JWTKeysetSchema = z.object({
  issuer: z.string().url(),
  activeKeyId: z.string().min(1),
  keys: z.array(JWTKeySchema).min(1),
});

const CredentialActiveKeySchema = z.object({
  keyId: z.string().min(1),
  publicKeyPem: z.string().min(1),
});

const CredentialDecryptKeySchema = z.object({
  keyId: z.string().min(1),
  privateKeyPem: z.string().min(1).optional(),
});

const CredentialKeysetSchema = z.object({
  active: CredentialActiveKeySchema,
  decrypt: z.array(CredentialDecryptKeySchema).default([]),
});

export type GatewayJWTKey = {
  keyId: string;
  publicJwk: JsonWebKey;
  privateKeyPem?: string;
};

export type GatewayJWTKeyset = {
  issuer: string;
  activeKeyId: string;
  keys: GatewayJWTKey[];
};

export type GatewayCredentialKeyset = z.infer<typeof CredentialKeysetSchema>;

export type GatewayAppConfig = {
  appBaseUrl: string;
  gatewayBaseUrl: string;
  issuer: string;
  accessTokenTtlSeconds: number;
  authorizationRequestTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  registrationCredentialTtlSeconds: number;
  rateLimitSecret: string;
  jwtKeyset: GatewayJWTKeyset;
  credentialKeyset: GatewayCredentialKeyset;
};

function parseJsonEnv(value: string | undefined, name: string): unknown {
  if (!value) {
    throw new Error(`${name} is required for MCP gateway`);
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error });
  }
}

export function getGatewayAppConfig(): GatewayAppConfig {
  const jwtKeyset = JWTKeysetSchema.parse(
    parseJsonEnv(
      getEnvVariable('MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON'),
      'MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON'
    )
  );
  const credentialKeyset = CredentialKeysetSchema.parse(
    parseJsonEnv(
      getEnvVariable('MCP_GATEWAY_CREDENTIAL_KEYSET_JSON'),
      'MCP_GATEWAY_CREDENTIAL_KEYSET_JSON'
    )
  );
  const activeKey = jwtKeyset.keys.find(key => key.keyId === jwtKeyset.activeKeyId);
  if (!activeKey?.privateKeyPem) {
    throw new Error('MCP gateway JWT active private key is required');
  }

  const rateLimitSecret = getEnvVariable('MCP_GATEWAY_RATE_LIMIT_SECRET');
  if (!rateLimitSecret) {
    throw new Error('MCP_GATEWAY_RATE_LIMIT_SECRET is required for MCP gateway');
  }

  return {
    appBaseUrl: getEnvVariable('MCP_GATEWAY_APP_BASE_URL') || 'https://app.kilo.ai',
    gatewayBaseUrl: getEnvVariable('MCP_GATEWAY_BASE_URL') || 'https://mcp.kilosessions.ai',
    issuer: jwtKeyset.issuer,
    accessTokenTtlSeconds: Number(getEnvVariable('MCP_GATEWAY_ACCESS_TOKEN_TTL_SECONDS') || '900'),
    authorizationRequestTtlSeconds: 30 * 60,
    authorizationCodeTtlSeconds: 10 * 60,
    registrationCredentialTtlSeconds: 30 * 24 * 60 * 60,
    rateLimitSecret,
    jwtKeyset,
    credentialKeyset,
  };
}
