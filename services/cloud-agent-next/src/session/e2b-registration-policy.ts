import { z } from 'zod';
import {
  E2B_DIRECT_TOKEN_CONSENT_VERSION,
  fetchByocE2BCredential,
  fetchByocE2BEnrollment,
  type ByocE2BStatus,
} from '../byoc/e2b-credential-resolver.js';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import {
  CurrentSessionMetadataSchema,
  type CredentialContainment,
} from '../persistence/session-metadata.js';
import { isOrgInList } from '../sandbox-id.js';
import {
  E2BSandboxProviderBindingSchema,
  sameSandboxProviderBinding,
  type E2BSandboxProviderBinding,
  type SandboxProviderBinding,
} from '../sandbox-provider-binding.js';
import { sessionPlaneFromId } from '../session-plane.js';
import type { Env } from '../types.js';
import type { SessionCreateRequest } from './session-requests.js';

export const E2BRegistrationPolicySchema = z
  .object({
    sandboxProviderBinding: E2BSandboxProviderBindingSchema,
    credentialContainment: z
      .object({
        github: z.literal(false),
        gitlab: z.literal(false),
        bitbucket: z.literal(false),
        kilocode: z.literal(false),
      })
      .strict(),
  })
  .strip();

export type E2BRegistrationPolicy = z.infer<typeof E2BRegistrationPolicySchema>;

type RegistrationRuntime = SessionCreateRequest['runtime'];
type EnrollmentEnv = Pick<Env, 'BYOC_E2B_ORG_IDS' | 'BYOC_VERCEL_ORG_IDS'>;

export function isByocE2BEnrolled(env: EnrollmentEnv, organizationId: string | undefined): boolean {
  return (
    organizationId !== undefined &&
    z.uuid().safeParse(organizationId).success &&
    isOrgInList(env.BYOC_E2B_ORG_IDS?.toLowerCase(), organizationId.toLowerCase())
  );
}

export function selectCustomerPaidProvider(
  env: EnrollmentEnv,
  organizationId: string | undefined
): 'vercel' | 'e2b' | undefined {
  if (organizationId === undefined) return undefined;
  const vercel = isOrgInList(env.BYOC_VERCEL_ORG_IDS, organizationId);
  const e2b = isByocE2BEnrolled(env, organizationId);
  if (vercel && e2b) throw new E2BProviderError('byoc_e2b_policy_mismatch');
  return e2b ? 'e2b' : vercel ? 'vercel' : undefined;
}

function validateConsent(binding: E2BSandboxProviderBinding, status: ByocE2BStatus): void {
  if (
    status.consentVersion !== E2B_DIRECT_TOKEN_CONSENT_VERSION ||
    !z.iso.datetime().safeParse(status.consentedAt).success
  ) {
    throw new E2BProviderError('byoc_e2b_consent_missing');
  }
  if (
    status.organizationId !== binding.organizationId ||
    status.credentialId !== binding.credentialId
  ) {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
}

export async function resolveE2BRegistrationPolicy(
  env: Env,
  organizationId: string,
  runtime: RegistrationRuntime
): Promise<E2BRegistrationPolicy> {
  if (
    !isByocE2BEnrolled(env, organizationId) ||
    runtime?.devcontainer === true ||
    runtime?.sandboxAllocation !== undefined
  ) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  const status = await fetchByocE2BEnrollment(env, organizationId.toLowerCase());
  const binding = E2BSandboxProviderBindingSchema.safeParse({
    kind: 'e2b',
    organizationId: status.organizationId,
    credentialId: status.credentialId,
  });
  if (!binding.success || binding.data.organizationId !== organizationId.toLowerCase()) {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
  validateConsent(binding.data, status);
  return {
    sandboxProviderBinding: binding.data,
    credentialContainment: { github: false, gitlab: false, bitbucket: false, kilocode: false },
  };
}

export function usesE2BRegistration(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (
    ('sandboxProvider' in value && value.sandboxProvider === 'e2b') ||
    ('sandboxProviderBinding' in value &&
      typeof value.sandboxProviderBinding === 'object' &&
      value.sandboxProviderBinding !== null &&
      'kind' in value.sandboxProviderBinding &&
      value.sandboxProviderBinding.kind === 'e2b')
  );
}

const RecordedE2BRegistrationSchema = E2BRegistrationPolicySchema.extend({
  cloudAgentSessionId: z.string().refine(value => sessionPlaneFromId(value) === 'control'),
  sandboxId: z.string().regex(/^ses-[0-9a-f]+$/),
  sandboxProvider: z.literal('e2b'),
  sandboxRoute: z.undefined().optional(),
});

export function readE2BRegistrationPolicy(
  recorded: Record<string, unknown>,
  organizationId: string | undefined,
  runtime: RegistrationRuntime
): E2BRegistrationPolicy | undefined {
  if (!usesE2BRegistration(recorded)) return undefined;
  const parsed = RecordedE2BRegistrationSchema.safeParse(recorded);
  if (
    !parsed.success ||
    parsed.data.sandboxProviderBinding.organizationId !== organizationId?.toLowerCase() ||
    runtime?.devcontainer === true ||
    runtime?.sandboxAllocation !== undefined
  ) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  return {
    sandboxProviderBinding: parsed.data.sandboxProviderBinding,
    credentialContainment: parsed.data.credentialContainment,
  };
}

export async function revalidateE2BRegistrationPolicy(
  env: Env,
  policy: {
    sandboxProviderBinding: SandboxProviderBinding;
    credentialContainment: CredentialContainment;
  }
): Promise<void> {
  if (policy.sandboxProviderBinding.kind !== 'e2b') return;
  const parsed = E2BRegistrationPolicySchema.safeParse(policy);
  if (!parsed.success) throw new E2BProviderError('byoc_e2b_policy_mismatch');
  const binding = parsed.data.sandboxProviderBinding;
  const credential = await fetchByocE2BCredential(env, {
    organizationId: binding.organizationId,
    credentialId: binding.credentialId,
  });
  validateConsent(binding, credential);
}

export function assertE2BRegistrationReplay(
  metadata: unknown,
  recorded: Record<string, unknown>,
  owner: { userId: string; organizationId?: string }
): void {
  const workspace =
    typeof metadata === 'object' && metadata !== null && 'workspace' in metadata
      ? metadata.workspace
      : undefined;
  if (!usesE2BRegistration(recorded) && !usesE2BRegistration(workspace)) return;
  const parsed = CurrentSessionMetadataSchema.safeParse(metadata);
  const policy = readE2BRegistrationPolicy(recorded, owner.organizationId, undefined);
  if (
    !policy ||
    !parsed.success ||
    parsed.data.identity.userId !== owner.userId ||
    parsed.data.identity.sessionId !== recorded.cloudAgentSessionId ||
    parsed.data.auth.kiloSessionId !== recorded.kiloSessionId ||
    parsed.data.workspace?.sandboxId !== recorded.sandboxId ||
    !parsed.data.workspace?.sandboxProviderBinding ||
    !sameSandboxProviderBinding(
      policy.sandboxProviderBinding,
      parsed.data.workspace.sandboxProviderBinding
    )
  ) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
}
