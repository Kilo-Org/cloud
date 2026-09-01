import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  parseVercelSandboxRuntimeDefaults,
  type VercelSandboxCredentials,
  type VercelSandboxRuntimeConfig,
} from '../agent-sandbox/vercel/vercel-runtime-config.js';
import type {
  VercelComputeCredentialEnvelope,
  VercelComputeSetupStatus,
  VercelComputeSetupStep,
} from '@kilocode/db/schema-types';
import type { Env } from '../types.js';
import { z } from 'zod';

const BYOC_VERCEL_ENVELOPE_SCHEME =
  'byoc-vercel-credential-rsa-aes-256-gcm' satisfies VercelComputeCredentialEnvelope['scheme'];
const BYOC_VERCEL_ENVELOPE_KEY_ID = 'agent-env-vars-v1';

const EnvelopeSchema = z.object({
  scheme: z.literal(BYOC_VERCEL_ENVELOPE_SCHEME),
  version: z.literal(1),
  keyId: z.literal(BYOC_VERCEL_ENVELOPE_KEY_ID),
  ciphertext: z.object({
    encryptedData: z.string().min(1),
    encryptedDEK: z.string().min(1),
    algorithm: z.literal('rsa-aes-256-gcm'),
    version: z.literal(1),
  }),
});

const SetupStepSchema = z.enum([
  'validating_access',
  'create_builder',
  'install_system_dependencies',
  'install_node_dependencies',
  'upload_runtime_artifacts',
  'verify_runtime_artifacts',
  'snapshot_builder',
  'create_validator',
  'launch_validator_wrapper',
  'verify_validator_call_home',
  'stop_validator',
  'confirm_terminal',
]);

const CredentialSchema = z.object({
  credentialId: z.uuid(),
  organizationId: z.uuid(),
  tokenEncrypted: EnvelopeSchema,
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  teamSlug: z.string().nullable(),
  projectSlug: z.string().nullable(),
  setupStatus: z.enum(['pending', 'building', 'ready', 'failed']),
  setupStep: SetupStepSchema.nullable(),
  setupError: z.string().nullable(),
  buildGeneration: z.uuid(),
  runtimeBuildId: z.string().nullable(),
  runtimeSnapshotId: z.string().nullable(),
  setupStartedAt: z.string().nullable(),
  setupCompletedAt: z.string().nullable(),
});

const EnrollmentSchema = z.object({
  credentialId: z.uuid(),
  organizationId: z.uuid(),
  setupStatus: z.enum(['pending', 'building', 'ready', 'failed']),
  setupStep: SetupStepSchema.nullable(),
  setupError: z.string().nullable(),
  buildGeneration: z.uuid(),
  runtimeBuildId: z.string().nullable(),
  runtimeSnapshotId: z.string().nullable(),
  teamSlug: z.string().nullable(),
  projectSlug: z.string().nullable(),
});

export type ByocVercelCredential = z.infer<typeof CredentialSchema> & {
  tokenEncrypted: VercelComputeCredentialEnvelope;
  setupStatus: VercelComputeSetupStatus;
  setupStep: VercelComputeSetupStep | null;
};

export type ByocVercelEnrollment = z.infer<typeof EnrollmentSchema>;

export type ByocVercelRuntimeSnapshot = {
  organizationId: string;
  credentialId: string;
  buildGeneration: string;
  runtimeSnapshotId: string;
};

export type ByocVercelStatusProjection = {
  organizationId: string;
  credentialId: string;
  buildGeneration: string;
  setupStatus: VercelComputeSetupStatus;
  setupStep: VercelComputeSetupStep | null;
  setupError: string | null;
  teamSlug: string | null;
  projectSlug: string | null;
  runtimeBuildId: string | null;
  runtimeSnapshotId: string | null;
  setupStartedAt: string | null;
  setupCompletedAt: string | null;
};

export class ByocCredentialMissingError extends Error {
  readonly code = 'byoc_credential_missing';

  constructor(credentialId: string) {
    super(`BYOC credential ${credentialId} is no longer available`);
    this.name = 'ByocCredentialMissingError';
  }
}

export class ByocVercelNotReadyError extends Error {
  readonly code = 'byoc_vercel_not_ready';

  constructor(status: VercelComputeSetupStatus) {
    super(`BYOC Vercel setup is ${status}`);
    this.name = 'ByocVercelNotReadyError';
  }
}

export class ByocCredentialResolverError extends Error {
  readonly code = 'byoc_credential_resolver_failed';

  constructor() {
    super('BYOC credential lookup failed');
    this.name = 'ByocCredentialResolverError';
  }
}

function backendUrl(env: Env): string {
  const value = env.KILOCODE_BACKEND_BASE_URL?.trim().replace(/\/+$/, '');
  if (!value) throw new ByocCredentialResolverError();
  return value;
}

async function internalSecret(env: Env): Promise<string> {
  try {
    const secret = await env.INTERNAL_API_SECRET_PROD.get();
    if (secret) return secret;
  } catch {
    // Convert secret-store failures into the same safe resolver error.
  }
  throw new ByocCredentialResolverError();
}

export async function fetchByocVercelCredential(
  env: Env,
  input: { organizationId: string; credentialId: string }
): Promise<ByocVercelCredential> {
  let response: Response;
  try {
    response = await fetch(
      `${backendUrl(env)}/api/internal/byoc/vercel-credentials/${encodeURIComponent(input.credentialId)}?organizationId=${encodeURIComponent(input.organizationId)}`,
      {
        method: 'GET',
        headers: { 'x-internal-api-key': await internalSecret(env) },
        cache: 'no-store',
      }
    );
  } catch {
    throw new ByocCredentialResolverError();
  }

  if (response.status === 404) {
    throw new ByocCredentialMissingError(input.credentialId);
  }
  if (!response.ok) {
    throw new ByocCredentialResolverError();
  }

  const parsed = CredentialSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ByocCredentialResolverError();
  if (
    parsed.data.organizationId !== input.organizationId ||
    parsed.data.credentialId !== input.credentialId
  ) {
    throw new ByocCredentialResolverError();
  }
  return parsed.data as ByocVercelCredential;
}

export async function fetchByocVercelEnrollment(
  env: Env,
  organizationId: string
): Promise<ByocVercelEnrollment> {
  let response: Response;
  try {
    response = await fetch(
      `${backendUrl(env)}/api/internal/byoc/vercel-credentials/organization/${encodeURIComponent(organizationId)}`,
      {
        method: 'GET',
        headers: { 'x-internal-api-key': await internalSecret(env) },
        cache: 'no-store',
      }
    );
  } catch {
    throw new ByocCredentialResolverError();
  }

  if (response.status === 404) {
    throw new ByocCredentialMissingError(organizationId);
  }
  if (!response.ok) throw new ByocCredentialResolverError();

  const parsed = EnrollmentSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.organizationId !== organizationId) {
    throw new ByocCredentialResolverError();
  }
  return parsed.data;
}

export async function projectByocVercelStatus(
  env: Env,
  input: ByocVercelStatusProjection
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(
      `${backendUrl(env)}/api/internal/byoc/vercel-credentials/${encodeURIComponent(input.credentialId)}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': await internalSecret(env),
        },
        body: JSON.stringify(input),
        cache: 'no-store',
      }
    );
  } catch {
    throw new ByocCredentialResolverError();
  }

  if (response.status === 404) return false;
  if (!response.ok) throw new ByocCredentialResolverError();
  const parsed = z
    .object({ updated: z.boolean() })
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ByocCredentialResolverError();
  return parsed.data.updated;
}

export async function projectByocVercelSnapshotMissing(
  env: Env,
  input: ByocVercelRuntimeSnapshot
): Promise<boolean> {
  const credential = await fetchByocVercelCredential(env, input);
  if (
    credential.setupStatus !== 'ready' ||
    credential.buildGeneration !== input.buildGeneration ||
    credential.runtimeSnapshotId !== input.runtimeSnapshotId
  ) {
    return false;
  }

  return projectByocVercelStatus(env, {
    organizationId: credential.organizationId,
    credentialId: credential.credentialId,
    buildGeneration: credential.buildGeneration,
    setupStatus: 'failed',
    setupStep: null,
    setupError: 'byoc_vercel_snapshot_missing',
    teamSlug: credential.teamSlug,
    projectSlug: credential.projectSlug,
    runtimeBuildId: credential.runtimeBuildId,
    runtimeSnapshotId: null,
    setupStartedAt: credential.setupStartedAt
      ? new Date(credential.setupStartedAt).toISOString()
      : null,
    setupCompletedAt: null,
  });
}

export async function resolveByocVercelRuntimeConfig(
  env: Env,
  input: { organizationId: string; credentialId: string },
  onSnapshotResolved?: (snapshot: ByocVercelRuntimeSnapshot) => void
): Promise<VercelSandboxRuntimeConfig> {
  const credential = await fetchByocVercelCredential(env, input);
  if (credential.setupStatus !== 'ready' || !credential.runtimeSnapshotId) {
    throw new ByocVercelNotReadyError(credential.setupStatus);
  }

  const config = decryptCredentialRuntimeConfig(env, credential);
  onSnapshotResolved?.({
    organizationId: credential.organizationId,
    credentialId: credential.credentialId,
    buildGeneration: credential.buildGeneration,
    runtimeSnapshotId: credential.runtimeSnapshotId,
  });
  return config;
}

export async function resolveByocVercelCredentials(
  env: Env,
  input: { organizationId: string; credentialId: string }
): Promise<VercelSandboxCredentials> {
  const credential = await fetchByocVercelCredential(env, input);
  return {
    accessToken: decryptCredentialAccessToken(env, credential),
    teamId: credential.teamId,
  };
}

export async function resolveByocVercelAccessConfig(
  env: Env,
  input: { organizationId: string; credentialId: string }
): Promise<VercelSandboxRuntimeConfig> {
  const credential = await fetchByocVercelCredential(env, input);
  return decryptCredentialRuntimeConfig(env, credential);
}

function decryptCredentialRuntimeConfig(
  env: Env,
  credential: ByocVercelCredential
): VercelSandboxRuntimeConfig {
  if (!credential.runtimeBuildId) throw new ByocCredentialResolverError();

  const defaults = parseVercelSandboxRuntimeDefaults(env);
  if (!defaults || !env.AGENT_ENV_VARS_PRIVATE_KEY) {
    throw new ByocCredentialResolverError();
  }

  return {
    ...defaults,
    accessToken: decryptCredentialAccessToken(env, credential),
    teamId: credential.teamId,
    projectId: credential.projectId,
    snapshotId: credential.runtimeSnapshotId ?? 'pending',
    runtimeBuildId: credential.runtimeBuildId,
  };
}

function decryptCredentialAccessToken(env: Env, credential: ByocVercelCredential): string {
  if (!env.AGENT_ENV_VARS_PRIVATE_KEY) throw new ByocCredentialResolverError();
  try {
    const accessToken = decryptKeyedEnvelope(
      JSON.stringify(credential.tokenEncrypted),
      BYOC_VERCEL_ENVELOPE_SCHEME,
      {
        active: {
          keyId: BYOC_VERCEL_ENVELOPE_KEY_ID,
          privateKeyPem: env.AGENT_ENV_VARS_PRIVATE_KEY,
        },
      },
      `byoc-vercel-credential:v1:${credential.organizationId}:${credential.credentialId}`
    ).trim();
    if (!accessToken) throw new Error('empty credential');
    return accessToken;
  } catch {
    throw new ByocCredentialResolverError();
  }
}
