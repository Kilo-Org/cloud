jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<typeof ConfigServerModule>('@/lib/config.server'),
  get INTERNAL_API_SECRET() {
    return mockInternalSecret;
  },
}));

import { generateKeyPairSync } from 'node:crypto';
import { organization_e2b_compute_credentials, organizations } from '@kilocode/db/schema';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import { eq, sql } from 'drizzle-orm';
import { NextRequest, type NextResponse } from 'next/server';
import type * as ConfigServerModule from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { GET as getExactCredential } from './[credentialId]/route';
import { GET as getOrganizationStatus } from './organization/[organizationId]/route';

const INTERNAL_KEY = 'e2b-internal-route-test-secret';
const API_KEY = 'e2b-route-test-key-do-not-expose';
const organizationId = crypto.randomUUID();
const otherOrganizationId = crypto.randomUUID();
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const timestamp = '2026-04-29 01:16:12.945+00';
const normalizedTimestamp = '2026-04-29T01:16:12.945Z';
let mockInternalSecret = INTERNAL_KEY;
let credentialId: string;

function encryptedApiKey(orgId: string, id: string) {
  const scheme = 'byoc-e2b-credential-rsa-aes-256-gcm';
  return parseKeyedEnvelope(
    encryptKeyedEnvelope(
      API_KEY,
      scheme,
      { keyId: 'agent-env-vars-v1', publicKeyPem: keys.publicKey },
      `byoc-e2b-credential:v1:${orgId}:${id}`
    ),
    scheme
  );
}

async function insertCredential(orgId: string, id: string) {
  const [row] = await db
    .insert(organization_e2b_compute_credentials)
    .values({
      id,
      organization_id: orgId,
      api_key_encrypted: encryptedApiKey(orgId, id),
      consent_version: 'e2b-direct-v1',
      consented_at: timestamp,
      validated_at: timestamp,
      created_at: timestamp,
    })
    .returning();
  return row;
}

function exactRequest({
  id = credentialId,
  orgId = organizationId,
  internalKey = INTERNAL_KEY,
}: { id?: string; orgId?: string | null; internalKey?: string | null } = {}) {
  const url = new URL(`http://localhost/api/internal/byoc/e2b-credentials/${id}`);
  if (orgId !== null) url.searchParams.set('organizationId', orgId);
  return getExactCredential(
    new NextRequest(url, { headers: internalKey ? { 'x-internal-api-key': internalKey } : {} }),
    { params: Promise.resolve({ credentialId: id }) }
  );
}

function statusRequest(orgId = organizationId, internalKey: string | null = INTERNAL_KEY) {
  return getOrganizationStatus(
    new NextRequest(`http://localhost/api/internal/byoc/e2b-credentials/organization/${orgId}`, {
      headers: internalKey ? { 'x-internal-api-key': internalKey } : {},
    }),
    { params: Promise.resolve({ organizationId: orgId }) }
  );
}

async function expectError(response: NextResponse, status: number, message: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: message });
}

function expectedStatus(id = credentialId) {
  return {
    credentialId: id,
    organizationId,
    consentVersion: 'e2b-direct-v1',
    consentedAt: normalizedTimestamp,
    validatedAt: normalizedTimestamp,
    createdAt: normalizedTimestamp,
  };
}

beforeAll(async () => {
  await db.insert(organizations).values([
    { id: organizationId, name: 'E2B internal routes test' },
    { id: otherOrganizationId, name: 'Other E2B internal routes test' },
  ]);
});

beforeEach(async () => {
  mockInternalSecret = INTERNAL_KEY;
  credentialId = crypto.randomUUID();
  await db
    .delete(organization_e2b_compute_credentials)
    .where(eq(organization_e2b_compute_credentials.organization_id, organizationId));
  await insertCredential(organizationId, credentialId);
});

describe('internal E2B credential authentication', () => {
  it.each([null, '', 'incorrect-secret'])(
    'requires the internal API key for both routes',
    async internalKey => {
      await expectError(await exactRequest({ id: 'invalid-id', internalKey }), 401, 'Unauthorized');
      await expectError(await statusRequest('invalid-id', internalKey), 401, 'Unauthorized');
    }
  );

  it('fails closed when server authentication is not configured', async () => {
    mockInternalSecret = '';
    await expectError(await exactRequest(), 401, 'Unauthorized');
    await expectError(await statusRequest(), 401, 'Unauthorized');
  });

  it('does not accept a bearer token in place of internal authentication', async () => {
    const request = new NextRequest(
      `http://localhost/api/internal/byoc/e2b-credentials/${credentialId}?organizationId=${organizationId}`,
      { headers: { Authorization: `Bearer ${INTERNAL_KEY}` } }
    );
    await expectError(
      await getExactCredential(request, { params: Promise.resolve({ credentialId }) }),
      401,
      'Unauthorized'
    );
  });
});

describe('exact-ID E2B credential resolution', () => {
  it('returns only the exact organization-bound envelope and normalized status', async () => {
    const row = await db.query.organization_e2b_compute_credentials.findFirst({
      where: eq(organization_e2b_compute_credentials.id, credentialId),
    });
    const response = await exactRequest();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body: unknown = await response.json();
    expect(body).toEqual({ ...expectedStatus(), apiKeyEncrypted: row?.api_key_encrypted });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it.each([null, '', 'not-an-organization-id'])(
    'requires a valid organization ID query parameter',
    async orgId => {
      await expectError(await exactRequest({ orgId }), 400, 'Invalid request');
    }
  );

  it('rejects invalid credential IDs and organization status IDs', async () => {
    await expectError(await exactRequest({ id: 'not-a-credential' }), 400, 'Invalid request');
    await expectError(await statusRequest('not-an-organization'), 400, 'Invalid request');
  });

  it('does not resolve another organization or a missing credential', async () => {
    await expectError(
      await exactRequest({ orgId: otherOrganizationId }),
      404,
      'Credential not found'
    );
    await expectError(await exactRequest({ id: crypto.randomUUID() }), 404, 'Credential not found');
    await expectError(await statusRequest(otherOrganizationId), 404, 'Credential not found');
  });

  it('sanitizes a malformed persisted envelope without echoing its contents', async () => {
    await db
      .update(organization_e2b_compute_credentials)
      .set({
        api_key_encrypted: sql`${JSON.stringify({ scheme: 'invalid', private: API_KEY })}::jsonb`,
      })
      .where(eq(organization_e2b_compute_credentials.id, credentialId));
    await expectError(await exactRequest(), 503, 'E2B credential is invalid');
  });

  it('does not repoint an old credential ID after removal and replacement', async () => {
    await db
      .delete(organization_e2b_compute_credentials)
      .where(eq(organization_e2b_compute_credentials.id, credentialId));
    const replacementId = crypto.randomUUID();
    const replacement = await insertCredential(organizationId, replacementId);
    await expectError(await exactRequest(), 404, 'Credential not found');
    expect(await (await exactRequest({ id: replacementId })).json()).toEqual({
      ...expectedStatus(replacementId),
      apiKeyEncrypted: replacement.api_key_encrypted,
    });
    expect(await (await statusRequest()).json()).toEqual(expectedStatus(replacementId));
  });
});

describe('organization E2B status', () => {
  it('returns normalized timestamps and no ciphertext without any enrollment gate', async () => {
    const response = await statusRequest();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body: unknown = await response.json();
    expect(body).toEqual(expectedStatus());
    expect(JSON.stringify(body)).not.toContain('encrypted');
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('deletes a credential through its organization foreign-key cascade', async () => {
    const deletedOrgId = crypto.randomUUID();
    await db.insert(organizations).values({ id: deletedOrgId, name: 'E2B cascade fixture' });
    const deletedCredentialId = crypto.randomUUID();
    await insertCredential(deletedOrgId, deletedCredentialId);
    await db.delete(organizations).where(eq(organizations.id, deletedOrgId));
    await expectError(
      await exactRequest({ id: deletedCredentialId, orgId: deletedOrgId }),
      404,
      'Credential not found'
    );
    await expectError(await statusRequest(deletedOrgId), 404, 'Credential not found');
  });
});
