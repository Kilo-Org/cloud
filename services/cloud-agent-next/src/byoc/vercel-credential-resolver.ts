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

const CredentialOwnerSchema = z.union([
  z.object({ organizationId: z.uuid(), userId: z.never().optional() }),
  z.object({ organizationId: z.never().optional(), userId: z.string().min(1) }),
]);

const CredentialFieldsSchema = z.object({
  credentialId: z.uuid(),
  tokenEncrypted: EnvelopeSchema,
  tokenScope: z.enum(['team', 'project']),
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
const CredentialSchema = CredentialFieldsSchema.and(CredentialOwnerSchema);

const EnrollmentFieldsSchema = z.object({
  credentialId: z.uuid(),
  setupStatus: z.enum(['pending', 'building', 'ready', 'failed']),
  setupStep: SetupStepSchema.nullable(),
  setupError: z.string().nullable(),
  buildGeneration: z.uuid(),
  runtimeBuildId: z.string().nullable(),
  runtimeSnapshotId: z.string().nullable(),
  teamSlug: z.string().nullable(),
  projectSlug: z.string().nullable(),
});
const EnrollmentSchema = EnrollmentFieldsSchema.and(CredentialOwnerSchema);

export type ByocVercelOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };
export type ByocVercelCredentialFetchInput = ByocVercelOwner & { credentialId: string };

export type ByocVercelCredential = ByocVercelOwner &
  z.infer<typeof CredentialFieldsSchema> & {
    tokenEncrypted: VercelComputeCredentialEnvelope;
    setupStatus: VercelComputeSetupStatus;
    setupStep: VercelComputeSetupStep | null;
  };

export type ByocVercelEnrollment = ByocVercelOwner & z.infer<typeof EnrollmentFieldsSchema>;

export type ByocVercelRuntimeSnapshot = ByocVercelOwner & {
  credentialId: string;
  buildGeneration: string;
  runtimeSnapshotId: string;
};

export type ByocVercelStatusProjection = ByocVercelOwner & {
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
  runtimeWrapperVersion?: string | null;
  runtimeReleasedAt?: string | null;
  runtimeDigest?: string | null;
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

function ownerId(owner: ByocVercelOwner): string {
  return owner.organizationId !== undefined ? owner.organizationId : owner.userId;
}

function ownerAadKey(owner: ByocVercelOwner): string {
  return owner.organizationId !== undefined ? owner.organizationId : `user:${owner.userId}`;
}

function ownerMatches(left: ByocVercelOwner, right: ByocVercelOwner): boolean {
  if (left.organizationId !== undefined && right.organizationId !== undefined) {
    return left.organizationId === right.organizationId;
  }
  if (left.userId !== undefined && right.userId !== undefined) return left.userId === right.userId;
  return false;
}

function ownerFields(owner: ByocVercelOwner): ByocVercelOwner {
  return owner.organizationId !== undefined
    ? { organizationId: owner.organizationId }
    : { userId: owner.userId };
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
  input: ByocVercelCredentialFetchInput
): Promise<ByocVercelCredential> {
  const ownerQuery =
    input.organizationId !== undefined
      ? `organizationId=${encodeURIComponent(input.organizationId)}`
      : `userId=${encodeURIComponent(input.userId)}`;
  let response: Response;
  try {
    response = await fetch(
      `${backendUrl(env)}/api/internal/byoc/vercel-credentials/${encodeURIComponent(input.credentialId)}?${ownerQuery}`,
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
  if (!ownerMatches(parsed.data, input) || parsed.data.credentialId !== input.credentialId) {
    throw new ByocCredentialResolverError();
  }
  return parsed.data as ByocVercelCredential;
}

export async function fetchByocVercelEnrollment(
  env: Env,
  organizationId: string
): Promise<ByocVercelEnrollment> {
  return fetchByocVercelEnrollmentForOwner(env, { organizationId }, 'organization');
}

export async function fetchByocVercelEnrollmentForUser(
  env: Env,
  userId: string
): Promise<ByocVercelEnrollment> {
  return fetchByocVercelEnrollmentForOwner(env, { userId }, 'user');
}

async function fetchByocVercelEnrollmentForOwner(
  env: Env,
  owner: ByocVercelOwner,
  path: 'organization' | 'user'
): Promise<ByocVercelEnrollment> {
  let response: Response;
  try {
    response = await fetch(
      `${backendUrl(env)}/api/internal/byoc/vercel-credentials/${path}/${encodeURIComponent(ownerId(owner))}`,
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
    throw new ByocCredentialMissingError(ownerId(owner));
  }
  if (!response.ok) throw new ByocCredentialResolverError();

  const parsed = EnrollmentSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !ownerMatches(parsed.data, owner)) {
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
    ...ownerFields(credential),
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
  input: ByocVercelCredentialFetchInput,
  onSnapshotResolved?: (snapshot: ByocVercelRuntimeSnapshot) => void
): Promise<VercelSandboxRuntimeConfig> {
  const credential = await fetchByocVercelCredential(env, input);
  if (credential.setupStatus !== 'ready' || !credential.runtimeSnapshotId) {
    throw new ByocVercelNotReadyError(credential.setupStatus);
  }

  const config = decryptCredentialRuntimeConfig(env, credential);
  onSnapshotResolved?.({
    ...ownerFields(credential),
    credentialId: credential.credentialId,
    buildGeneration: credential.buildGeneration,
    runtimeSnapshotId: credential.runtimeSnapshotId,
  });
  return config;
}

export async function resolveByocVercelCredentials(
  env: Env,
  input: ByocVercelCredentialFetchInput
): Promise<VercelSandboxCredentials> {
  const credential = await fetchByocVercelCredential(env, input);
  return {
    accessToken: decryptCredentialAccessToken(env, credential),
    teamId: credential.teamId,
    scope: credential.tokenScope,
  };
}

export async function resolveByocVercelAccessConfig(
  env: Env,
  input: ByocVercelCredentialFetchInput
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
    scope: credential.tokenScope,
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
      `byoc-vercel-credential:v1:${ownerAadKey(credential)}:${credential.credentialId}`
    ).trim();
    if (!accessToken) throw new Error('empty credential');
    return accessToken;
  } catch {
    throw new ByocCredentialResolverError();
  }
}
