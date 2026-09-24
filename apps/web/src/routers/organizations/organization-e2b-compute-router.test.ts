jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  getE2BComputeEnrollment: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<typeof ConfigServerModule>('@/lib/config.server'),
  get AGENT_ENV_VARS_PUBLIC_KEY() {
    return mockEncryptionConfig.publicKey;
  },
}));

import { generateKeyPairSync } from 'node:crypto';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { TRPCError } from '@trpc/server';
import { eq, inArray } from 'drizzle-orm';
import {
  organization_e2b_compute_credentials,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import type * as ConfigServerModule from '@/lib/config.server';
import { getE2BComputeEnrollment } from '@/lib/cloud-agent-next/cloud-agent-client';
import { db } from '@/lib/drizzle';
import { createCallerFactory } from '@/lib/trpc/init';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { organizationE2BComputeRouter } from './organization-e2b-compute-router';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const mockEncryptionConfig = { publicKey: Buffer.from(keys.publicKey).toString('base64') };
const API_KEY = 'opaque-router-test-key-do-not-expose';
const PROVIDER_DETAIL = 'private-provider-response-detail';
const organizationId = crypto.randomUUID();
const otherOrganizationId = crypto.randomUUID();
const setupInput = {
  organizationId,
  apiKey: API_KEY,
  acknowledgeDirectTokenAccess: true,
  consentVersion: 'e2b-direct-v1',
} as const;
const createCaller = createCallerFactory(organizationE2BComputeRouter);
const mockEnrollment = jest.mocked(getE2BComputeEnrollment);
const privateKeys = { active: { keyId: 'agent-env-vars-v1', privateKeyPem: keys.privateKey } };

let owner: User;
let admin: User;
let billingManager: User;
let member: User;
let outsider: User;
let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeAll(async () => {
  [owner, admin, billingManager, member, outsider] = await Promise.all(
    Array.from({ length: 5 }, () => insertTestUser())
  );
  await db.insert(organizations).values([
    { id: organizationId, name: 'E2B Connection Test' },
    { id: otherOrganizationId, name: 'Other E2B Connection Test' },
  ]);
  await db.insert(organization_memberships).values([
    { organization_id: organizationId, kilo_user_id: owner.id, role: 'owner' },
    { organization_id: organizationId, kilo_user_id: admin.id, role: 'admin' },
    { organization_id: organizationId, kilo_user_id: billingManager.id, role: 'billing_manager' },
    { organization_id: organizationId, kilo_user_id: member.id, role: 'member' },
    { organization_id: otherOrganizationId, kilo_user_id: outsider.id, role: 'owner' },
  ]);
});

beforeEach(async () => {
  await db
    .delete(organization_e2b_compute_credentials)
    .where(
      inArray(organization_e2b_compute_credentials.organization_id, [
        organizationId,
        otherOrganizationId,
      ])
    );
  jest.resetAllMocks();
  mockEncryptionConfig.publicKey = Buffer.from(keys.publicKey).toString('base64');
  mockEnrollment.mockResolvedValue({ enrolled: true });
  fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([]));
});

afterEach(() => {
  jest.restoreAllMocks();
});

function getCredential(id = organizationId) {
  return db.query.organization_e2b_compute_credentials.findFirst({
    where: eq(organization_e2b_compute_credentials.organization_id, id),
  });
}

async function expectSafeError(result: Promise<unknown>, code: TRPCError['code']) {
  const error: unknown = await result.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(TRPCError);
  if (!(error instanceof TRPCError)) throw new Error('Expected a TRPCError');
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).not.toContain(PROVIDER_DETAIL);
  expect(serialized).not.toContain('encryptedDEK');
}

describe('E2B organization authorization and consent', () => {
  it.each(['owner', 'admin'])(
    'allows the organization %s to save only a consented encrypted key',
    async role => {
      const caller = createCaller({ user: role === 'owner' ? owner : admin });
      const status = await caller.add(setupInput);
      const row = await getCredential();
      if (!row) throw new Error('Expected a stored connection');

      expect(status).toEqual({
        credentialId: row.id,
        organizationId,
        consentVersion: 'e2b-direct-v1',
        consentedAt: new Date(row.consented_at).toISOString(),
        validatedAt: new Date(row.validated_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString(),
      });
      expect(row.api_key_encrypted).toMatchObject({
        scheme: 'byoc-e2b-credential-rsa-aes-256-gcm',
        keyId: 'agent-env-vars-v1',
        version: 1,
      });
      expect(JSON.stringify(row)).not.toContain(API_KEY);
      expect(JSON.stringify(status)).not.toContain('encrypted');
      expect(await caller.getStatus({ organizationId })).toEqual(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
      expect(
        decryptKeyedEnvelope(
          JSON.stringify(row.api_key_encrypted),
          'byoc-e2b-credential-rsa-aes-256-gcm',
          privateKeys,
          `byoc-e2b-credential:v1:${organizationId}:${row.id}`
        )
      ).toBe(API_KEY);
    }
  );

  it('rejects non-admin roles and other tenants before enrollment or provider calls', async () => {
    for (const user of [billingManager, member, outsider]) {
      const caller = createCaller({ user });
      await expectSafeError(caller.getEnrollment({ organizationId }), 'UNAUTHORIZED');
      await expectSafeError(caller.getStatus({ organizationId }), 'UNAUTHORIZED');
      await expectSafeError(caller.add(setupInput), 'UNAUTHORIZED');
      await expectSafeError(
        caller.remove({
          organizationId,
          credentialId: crypto.randomUUID(),
          acknowledgeRemoval: true,
        }),
        'UNAUTHORIZED'
      );
    }
    expect(mockEnrollment).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getCredential()).toBeUndefined();
  });

  it.each([undefined, false, 'true', 1])(
    'rejects non-literal direct-token acknowledgment %s',
    async acknowledgment => {
      const caller = createCaller({ user: owner });
      const input = { ...setupInput, acknowledgeDirectTokenAccess: acknowledgment } as Parameters<
        typeof caller.add
      >[0];
      await expect(caller.add(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockEnrollment).not.toHaveBeenCalled();
      expect(await getCredential()).toBeUndefined();
    }
  );

  it.each([undefined, '', 'e2b-direct-v0', 'e2b-direct-v2'])(
    'requires an explicit current consent version %s',
    async consentVersion => {
      const caller = createCaller({ user: owner });
      const input = { ...setupInput, consentVersion } as Parameters<typeof caller.add>[0];
      await expect(caller.add(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockEnrollment).not.toHaveBeenCalled();
    }
  );

  it.each(['', '   ', 'x'.repeat(4097)])('rejects empty or oversized API keys', async apiKey => {
    await expect(
      createCaller({ user: owner }).add({ ...setupInput, apiKey })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the Worker enrollment result and fails closed when it is unavailable', async () => {
    const caller = createCaller({ user: owner });
    mockEnrollment.mockResolvedValue({ enrolled: false });
    await expect(caller.getEnrollment({ organizationId })).resolves.toEqual({ enrolled: false });
    await expectSafeError(caller.add(setupInput), 'FORBIDDEN');
    mockEnrollment.mockRejectedValue(new Error(API_KEY, { cause: PROVIDER_DETAIL }));
    await expectSafeError(caller.getEnrollment({ organizationId }), 'SERVICE_UNAVAILABLE');
    await expectSafeError(caller.add(setupInput), 'SERVICE_UNAVAILABLE');
    expect(mockEnrollment).toHaveBeenCalledWith({ organizationId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getCredential()).toBeUndefined();
  });
});

describe('E2B connection persistence', () => {
  it('binds the envelope to canonical organization and credential IDs', async () => {
    const caller = createCaller({ user: owner });
    await caller.add({
      ...setupInput,
      organizationId: organizationId.toUpperCase(),
      apiKey: ` ${API_KEY}\n`,
    });
    const row = await getCredential();
    if (!row) throw new Error('Expected a stored connection');
    const envelope = JSON.stringify(row.api_key_encrypted);
    const decrypt = (orgId: string, credentialId: string) =>
      decryptKeyedEnvelope(
        envelope,
        'byoc-e2b-credential-rsa-aes-256-gcm',
        privateKeys,
        `byoc-e2b-credential:v1:${orgId}:${credentialId}`
      );
    expect(decrypt(organizationId, row.id)).toBe(API_KEY);
    expect(() => decrypt(otherOrganizationId, row.id)).toThrow();
    expect(() => decrypt(organizationId, crypto.randomUUID())).toThrow();
    expect(mockEnrollment).toHaveBeenCalledWith({ organizationId });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-API-Key': API_KEY });
  });

  it('normalizes production-shaped database timestamps without exposing ciphertext', async () => {
    const caller = createCaller({ user: owner });
    await caller.add(setupInput);
    await db
      .update(organization_e2b_compute_credentials)
      .set({
        consented_at: '2026-04-29 01:16:12.945+00',
        validated_at: '2026-04-29 03:16:12.945+02',
        created_at: '2026-04-29 01:16:13+00',
      })
      .where(eq(organization_e2b_compute_credentials.organization_id, organizationId));
    const status = await caller.getStatus({ organizationId });
    expect(status).toMatchObject({
      consentedAt: '2026-04-29T01:16:12.945Z',
      validatedAt: '2026-04-29T01:16:12.945Z',
      createdAt: '2026-04-29T01:16:13.000Z',
    });
    expect(Object.keys(status ?? {}).sort()).toEqual([
      'consentVersion',
      'consentedAt',
      'createdAt',
      'credentialId',
      'organizationId',
      'validatedAt',
    ]);
  });

  it('keeps one immutable connection when two admins race to add', async () => {
    let release: () => void = () => undefined;
    const bothRequests = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      if (++calls === 2) release();
      await bothRequests;
      return Response.json([]);
    });
    const results = await Promise.allSettled([
      createCaller({ user: owner }).add(setupInput),
      createCaller({ user: admin }).add({ ...setupInput, apiKey: `${API_KEY}-other` }),
    ]);
    const saved = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(saved).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CONFLICT' });
    expect(await getCredential()).toMatchObject({ id: saved[0]?.value.credentialId });
  });

  it('rejects replacement in place without validating the new key', async () => {
    const caller = createCaller({ user: owner });
    await caller.add(setupInput);
    const original = await getCredential();
    fetchMock.mockClear();
    await expectSafeError(caller.add({ ...setupInput, apiKey: 'another-key' }), 'CONFLICT');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getCredential()).toEqual(original);
  });

  it('surfaces a concurrent organization deletion as a database failure, not a conflict', async () => {
    const deletedOrgId = crypto.randomUUID();
    await db
      .insert(organizations)
      .values({ id: deletedOrgId, name: 'Concurrent deletion fixture' });
    await db.insert(organization_memberships).values({
      organization_id: deletedOrgId,
      kilo_user_id: owner.id,
      role: 'owner',
    });
    fetchMock.mockImplementationOnce(async () => {
      await db.delete(organizations).where(eq(organizations.id, deletedOrgId));
      return Response.json([]);
    });
    await expectSafeError(
      createCaller({ user: owner }).add({ ...setupInput, organizationId: deletedOrgId }),
      'INTERNAL_SERVER_ERROR'
    );
    expect(await getCredential(deletedOrgId)).toBeUndefined();
  });

  it.each([401, 403, 429, 503])(
    'does not persist a provider-rejected key for HTTP %s',
    async status => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ error: `${API_KEY} ${PROVIDER_DETAIL}` }, { status })
      );
      const code =
        status === 401
          ? 'UNAUTHORIZED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 429
              ? 'TOO_MANY_REQUESTS'
              : 'SERVICE_UNAVAILABLE';
      await expectSafeError(createCaller({ user: owner }).add(setupInput), code);
      expect(await getCredential()).toBeUndefined();
    }
  );

  it.each(['', 'not-a-public-key'])(
    'sanitizes unavailable encryption without contacting E2B',
    async publicKey => {
      mockEncryptionConfig.publicKey = publicKey;
      await expectSafeError(createCaller({ user: owner }).add(setupInput), 'INTERNAL_SERVER_ERROR');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await getCredential()).toBeUndefined();
    }
  );
});

describe('E2B exact connection removal', () => {
  it('keeps status and idempotent removal available without enrollment or a subscription', async () => {
    const caller = createCaller({ user: owner });
    const status = await caller.add(setupInput);
    mockEnrollment.mockReset().mockRejectedValue(new Error('Enrollment unavailable'));
    fetchMock.mockClear();

    await expect(caller.getStatus({ organizationId })).resolves.toEqual(status);
    const input = {
      organizationId,
      credentialId: status.credentialId,
      acknowledgeRemoval: true,
    } as const;
    await expect(Promise.all([caller.remove(input), caller.remove(input)])).resolves.toEqual([
      { success: true },
      { success: true },
    ]);
    await expect(caller.getStatus({ organizationId })).resolves.toBeNull();
    expect(mockEnrollment).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, false, 'true'])(
    'requires literal removal acknowledgment %s',
    async acknowledgeRemoval => {
      const caller = createCaller({ user: owner });
      const status = await caller.add(setupInput);
      const input = {
        organizationId,
        credentialId: status.credentialId,
        acknowledgeRemoval,
      } as Parameters<typeof caller.remove>[0];
      await expect(caller.remove(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await getCredential()).toBeDefined();
    }
  );

  it('requires a credential ID and never removes another tenant connection', async () => {
    const caller = createCaller({ user: owner });
    const otherStatus = await createCaller({ user: outsider }).add({
      ...setupInput,
      organizationId: otherOrganizationId,
    });
    await expect(
      caller.remove({ organizationId, acknowledgeRemoval: true } as Parameters<
        typeof caller.remove
      >[0])
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.remove({
        organizationId,
        credentialId: otherStatus.credentialId,
        acknowledgeRemoval: true,
      })
    ).resolves.toEqual({ success: true });
    expect(await getCredential(otherOrganizationId)).toMatchObject({
      id: otherStatus.credentialId,
    });
  });

  it('never deletes a replacement when a stale removal is repeated', async () => {
    const caller = createCaller({ user: owner });
    const original = await caller.add(setupInput);
    const removeInput = {
      organizationId,
      credentialId: original.credentialId,
      acknowledgeRemoval: true,
    } as const;
    await caller.remove(removeInput);
    const replacement = await caller.add({ ...setupInput, apiKey: `${API_KEY}-replacement` });
    expect(replacement.credentialId).not.toBe(original.credentialId);
    await caller.remove(removeInput);
    expect(await caller.getStatus({ organizationId })).toEqual(replacement);
  });
});
