import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchByocE2BCredential,
  fetchByocE2BEnrollment,
  type ByocE2BStatus,
} from '../byoc/e2b-credential-resolver.js';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import type * as E2BCredentialResolver from '../byoc/e2b-credential-resolver.js';
import type { Env } from '../types.js';
import {
  assertE2BRegistrationReplay,
  isByocE2BEnrolled,
  readE2BRegistrationPolicy,
  resolveE2BRegistrationPolicy,
  revalidateE2BRegistrationPolicy,
  selectCustomerPaidProvider,
} from './e2b-registration-policy.js';

vi.mock('../byoc/e2b-credential-resolver.js', async importOriginal => {
  const actual = await importOriginal<typeof E2BCredentialResolver>();
  return { ...actual, fetchByocE2BEnrollment: vi.fn(), fetchByocE2BCredential: vi.fn() };
});

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credentialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const policy = {
  sandboxProviderBinding: { kind: 'e2b', organizationId, credentialId },
  credentialContainment: { github: false, gitlab: false, bitbucket: false, kilocode: false },
} as const;
const status: ByocE2BStatus = {
  organizationId,
  credentialId,
  consentVersion: 'e2b-direct-v1',
  consentedAt: '2026-09-03T10:00:00.000Z',
  validatedAt: '2026-09-03T10:00:01.000Z',
  createdAt: '2026-09-03T10:00:02.000Z',
};
const credential = {
  ...status,
  apiKeyEncrypted: {
    scheme: 'byoc-e2b-credential-rsa-aes-256-gcm',
    version: 1,
    keyId: 'agent-env-vars-v1',
    ciphertext: {
      encryptedData: 'opaque-ciphertext',
      encryptedDEK: 'opaque-key',
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    },
  },
} as const;
const recorded = {
  cloudAgentSessionId: 'workspace_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  kiloSessionId: 'ses_12345678901234567890123456',
  sandboxId: 'ses-abcdef',
  sandboxProvider: 'e2b',
  ...policy,
};
const owner = { userId: 'oauth/user', organizationId };
const metadata = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: recorded.cloudAgentSessionId,
    userId: owner.userId,
    orgId: organizationId,
  },
  auth: { kiloSessionId: recorded.kiloSessionId },
  workspace: { sandboxId: recorded.sandboxId, sandboxProvider: 'e2b', ...policy },
  lifecycle: { version: 1, timestamp: 1 },
};

function environment(values: Partial<Env> = {}): Env {
  return {
    BYOC_E2B_ORG_IDS: organizationId,
    CREDENTIAL_CONTAINMENT_ENABLED: 'true',
    ...values,
  } as Env;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchByocE2BEnrollment).mockResolvedValue(status);
  vi.mocked(fetchByocE2BCredential).mockResolvedValue(credential);
});

describe('E2B enrollment and cloud-provider selection', () => {
  it.each([undefined, '', ' ', otherId])('does not enroll with allowlist %j', allowlist => {
    expect(isByocE2BEnrolled({ BYOC_E2B_ORG_IDS: allowlist }, organizationId)).toBe(false);
  });

  it.each([undefined, '', 'not-a-uuid'])(
    'never enrolls a personal or invalid organization %j',
    id => {
      const env = { BYOC_E2B_ORG_IDS: '*', BYOC_VERCEL_ORG_IDS: '*' };
      expect(isByocE2BEnrolled(env, id)).toBe(false);
      if (id === undefined) expect(selectCustomerPaidProvider(env, id)).toBeUndefined();
    }
  );

  it.each(['*', organizationId, ` ${otherId}, ${organizationId.toUpperCase()} `])(
    'admits only the matching canonical organization from %s',
    allowlist => {
      expect(isByocE2BEnrolled({ BYOC_E2B_ORG_IDS: allowlist }, organizationId.toUpperCase())).toBe(
        true
      );
    }
  );

  it('keeps managed and Vercel routing when E2B enrollment is empty', () => {
    expect(selectCustomerPaidProvider({}, organizationId)).toBeUndefined();
    expect(
      selectCustomerPaidProvider({ BYOC_VERCEL_ORG_IDS: organizationId }, organizationId)
    ).toBe('vercel');
    expect(selectCustomerPaidProvider({ BYOC_E2B_ORG_IDS: organizationId }, organizationId)).toBe(
      'e2b'
    );
  });

  it.each([organizationId, '*'])('rejects overlapping Vercel enrollment %s', vercel => {
    expect(() =>
      selectCustomerPaidProvider(
        { BYOC_VERCEL_ORG_IDS: vercel, BYOC_E2B_ORG_IDS: '*' },
        organizationId
      )
    ).toThrow(expect.objectContaining({ code: 'byoc_e2b_policy_mismatch' }));
  });
});

describe('new E2B registration consent', () => {
  it('derives all four false flags only from the validated connection and consent', async () => {
    const env = environment();
    await expect(
      resolveE2BRegistrationPolicy(env, organizationId.toUpperCase(), undefined)
    ).resolves.toEqual(policy);
    expect(fetchByocE2BEnrollment).toHaveBeenCalledWith(env, organizationId);
    expect(fetchByocE2BCredential).not.toHaveBeenCalled();
  });

  it.each([
    'byoc_e2b_credential_missing',
    'byoc_e2b_credential_invalid',
    'byoc_e2b_consent_missing',
    'byoc_e2b_unavailable',
  ] as const)('propagates %s instead of producing managed compute', async code => {
    vi.mocked(fetchByocE2BEnrollment).mockRejectedValueOnce(new E2BProviderError(code));
    await expect(
      resolveE2BRegistrationPolicy(environment(), organizationId, undefined)
    ).rejects.toMatchObject({ code });
  });

  it.each([
    { consentVersion: 'old-consent' },
    { consentVersion: undefined },
    { consentedAt: undefined },
    { consentedAt: '2026-09-03 10:00:00+00' },
  ])('rejects absent or invalid direct-token consent: %j', change => {
    vi.mocked(fetchByocE2BEnrollment).mockResolvedValueOnce({
      ...status,
      ...change,
    } as ByocE2BStatus);
    return expect(
      resolveE2BRegistrationPolicy(environment(), organizationId, undefined)
    ).rejects.toMatchObject({ code: 'byoc_e2b_consent_missing' });
  });

  it.each([{ organizationId: otherId }, { credentialId: '' }])(
    'rejects an invalid connection identity: %j',
    change => {
      vi.mocked(fetchByocE2BEnrollment).mockResolvedValueOnce({ ...status, ...change });
      return expect(
        resolveE2BRegistrationPolicy(environment(), organizationId, undefined)
      ).rejects.toMatchObject({ code: 'byoc_e2b_credential_invalid' });
    }
  );

  it.each([{ devcontainer: true }, { sandboxAllocation: 'isolated-standard' }] as const)(
    'rejects unsupported runtime %j before credential lookup',
    async runtime => {
      await expect(
        resolveE2BRegistrationPolicy(environment(), organizationId, runtime)
      ).rejects.toMatchObject({ code: 'byoc_e2b_policy_mismatch' });
      expect(fetchByocE2BEnrollment).not.toHaveBeenCalled();
    }
  );

  it('rejects a disabled pilot before credential lookup', async () => {
    await expect(
      resolveE2BRegistrationPolicy(environment({ BYOC_E2B_ORG_IDS: '' }), organizationId, undefined)
    ).rejects.toMatchObject({ code: 'byoc_e2b_policy_mismatch' });
    expect(fetchByocE2BEnrollment).not.toHaveBeenCalled();
  });
});

describe('saved E2B policy and exact-credential recovery', () => {
  it('uses saved policy and exact consent despite current enrollment and containment changes', async () => {
    const env = environment({
      BYOC_E2B_ORG_IDS: '',
      BYOC_VERCEL_ORG_IDS: '*',
      CREDENTIAL_CONTAINMENT_ENABLED: 'false',
    });
    const saved = readE2BRegistrationPolicy(recorded, organizationId, undefined);
    expect(saved).toEqual(policy);
    if (!saved) throw new Error('Expected saved E2B policy');
    await expect(revalidateE2BRegistrationPolicy(env, saved)).resolves.toBeUndefined();
    expect(fetchByocE2BCredential).toHaveBeenCalledWith(env, { organizationId, credentialId });
    expect(fetchByocE2BEnrollment).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).not.toContain('opaque');
  });

  it.each([
    { credentialContainment: undefined },
    { credentialContainment: { github: false, gitlab: false, kilocode: false } },
    { credentialContainment: { ...policy.credentialContainment, kilocode: true } },
    { sandboxProvider: 'vercel' },
    { sandboxProviderBinding: undefined },
    { sandboxProviderBinding: { kind: 'e2b' } },
    { sandboxProviderBinding: { ...policy.sandboxProviderBinding, organizationId: otherId } },
    { cloudAgentSessionId: 'agent_existing' },
    { sandboxId: 'org-abcdef' },
    { sandboxRoute: { kind: 'shared', routeKey: 'org-abcdef' } },
  ])('fails closed rather than reselecting a malformed saved allocation: %j', change => {
    expect(() =>
      readE2BRegistrationPolicy({ ...recorded, ...change }, organizationId, undefined)
    ).toThrow(expect.objectContaining({ code: 'byoc_e2b_policy_mismatch' }));
    expect(fetchByocE2BCredential).not.toHaveBeenCalled();
    expect(fetchByocE2BEnrollment).not.toHaveBeenCalled();
  });

  it.each(['byoc_e2b_credential_missing', 'byoc_e2b_consent_missing'] as const)(
    'rejects partial recovery after %s without changing the connection',
    async code => {
      vi.mocked(fetchByocE2BCredential).mockRejectedValueOnce(new E2BProviderError(code));
      await expect(revalidateE2BRegistrationPolicy(environment(), policy)).rejects.toMatchObject({
        code,
      });
      expect(fetchByocE2BEnrollment).not.toHaveBeenCalled();
    }
  );

  it('rejects consent or identity changes from the exact credential lookup', async () => {
    vi.mocked(fetchByocE2BCredential).mockResolvedValueOnce({
      ...credential,
      credentialId: otherId,
    });
    await expect(revalidateE2BRegistrationPolicy(environment(), policy)).rejects.toMatchObject({
      code: 'byoc_e2b_credential_invalid',
    });
    vi.mocked(fetchByocE2BCredential).mockResolvedValueOnce({
      ...credential,
      consentedAt: 'invalid',
    });
    await expect(revalidateE2BRegistrationPolicy(environment(), policy)).rejects.toMatchObject({
      code: 'byoc_e2b_consent_missing',
    });
  });

  it('does not add connection validation to existing providers', async () => {
    expect(
      readE2BRegistrationPolicy({ sandboxProvider: 'cloudflare' }, undefined, undefined)
    ).toBeUndefined();
    await revalidateE2BRegistrationPolicy(environment(), {
      sandboxProviderBinding: { kind: 'vercel', source: { kind: 'platform' } },
      credentialContainment: { github: true, gitlab: false, kilocode: true },
    });
    expect(fetchByocE2BCredential).not.toHaveBeenCalled();
  });
});

describe('completed E2B registration replay', () => {
  it('validates saved metadata without fetching a possibly removed credential', () => {
    expect(() => assertE2BRegistrationReplay(metadata, recorded, owner)).not.toThrow();
    expect(fetchByocE2BCredential).not.toHaveBeenCalled();
    expect(fetchByocE2BEnrollment).not.toHaveBeenCalled();
  });

  it.each([
    { credentialContainment: { ...policy.credentialContainment, github: true } },
    { sandboxProviderBinding: { ...policy.sandboxProviderBinding, credentialId: otherId } },
    { sandboxProviderBinding: undefined },
    { sandboxId: 'ses-123456' },
  ])('rejects changed persisted workspace policy or identity: %j', change => {
    expect(() =>
      assertE2BRegistrationReplay(
        { ...metadata, workspace: { ...metadata.workspace, ...change } },
        recorded,
        owner
      )
    ).toThrow(expect.objectContaining({ code: 'byoc_e2b_policy_mismatch' }));
  });

  it('rejects wrong session ownership and an E2B record replacing a managed allocation', () => {
    expect(() =>
      assertE2BRegistrationReplay(metadata, recorded, { ...owner, userId: 'other-user' })
    ).toThrow(expect.objectContaining({ code: 'byoc_e2b_policy_mismatch' }));
    expect(() =>
      assertE2BRegistrationReplay(
        metadata,
        {
          ...recorded,
          sandboxProvider: 'cloudflare',
          sandboxProviderBinding: { kind: 'cloudflare' },
        },
        owner
      )
    ).toThrow(expect.objectContaining({ code: 'byoc_e2b_policy_mismatch' }));
  });
});
