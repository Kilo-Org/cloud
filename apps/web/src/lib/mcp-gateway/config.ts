import 'server-only';
import { APP_URL } from '@/lib/constants';
import { getEnvVariable } from '@/lib/dotenvx';
import { z } from 'zod';

type GatewayPublicJwk = Pick<
  JsonWebKey,
  | 'alg'
  | 'crv'
  | 'd'
  | 'dp'
  | 'dq'
  | 'e'
  | 'ext'
  | 'k'
  | 'key_ops'
  | 'kty'
  | 'n'
  | 'oth'
  | 'p'
  | 'q'
  | 'qi'
  | 'use'
  | 'x'
  | 'y'
>;

const PublicJwkSchema = z
  .object({
    kty: z.string().min(1),
  })
  .passthrough();

const JWTKeySchema = z.object({
  keyId: z.string().min(1),
  publicJwk: PublicJwkSchema,
  publicKeyPem: z.string().min(1).optional(),
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
  publicJwk: GatewayPublicJwk;
  publicKeyPem?: string;
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
    appBaseUrl: getEnvVariable('MCP_GATEWAY_APP_BASE_URL') || APP_URL,
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
