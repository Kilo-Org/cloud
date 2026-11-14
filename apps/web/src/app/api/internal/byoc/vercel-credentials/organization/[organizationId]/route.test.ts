import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { byoc_connections } from '@kilocode/db/schema';
import type { VercelComputeCredentialEnvelope } from '@kilocode/db/schema-types';
import {
  BYOC_INTERNAL_API_SECRET,
  INTERNAL_API_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET } from './route';

const credentialEnvelope = {
  scheme: 'byoc-vercel-credential-rsa-aes-256-gcm',
  version: 1,
  keyId: 'test-key',
  ciphertext: {
    encryptedData: 'encrypted-data',
    encryptedDEK: 'encrypted-dek',
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  },
} satisfies VercelComputeCredentialEnvelope;

const authorized = { 'x-internal-api-key': BYOC_INTERNAL_API_SECRET };

async function enrollOrganization(organizationId: string) {
  const [row] = await db
    .insert(byoc_connections)
    .values({
      id: randomUUID(),
      provider: 'vercel',
      user_id: null,
      organization_id: organizationId,
      credentials_encrypted: credentialEnvelope,
      config: {
        token_scope: 'team',
        team_id: 'team_test',
        project_id: 'prj_test',
        team_slug: 'team-slug',
        project_slug: 'project-slug',
      },
      runtime: { runtime_build_id: 'build-1' },
      setup_status: 'building',
      setup_step: 'install_node_dependencies',
    })
    .returning();
  if (!row) throw new Error('Missing enrollment fixture');
  return row;
}

async function enrollUser(userId: string) {
  const [row] = await db
    .insert(byoc_connections)
    .values({
      id: randomUUID(),
      provider: 'vercel',
      user_id: userId,
      organization_id: null,
      credentials_encrypted: credentialEnvelope,
      config: { token_scope: 'team', team_id: 'team_test', project_id: 'prj_test' },
    })
    .returning();
  if (!row) throw new Error('Missing enrollment fixture');
  return row;
}

function request(organizationId: string, headers?: Record<string, string>) {
  return new NextRequest(
    `http://localhost/api/internal/byoc/vercel-credentials/organization/${organizationId}`,
    { method: 'GET', ...(headers ? { headers } : {}) }
  );
}

function expectNoEnrollmentFields(body: unknown) {
  expect(body).toEqual({ error: 'Unauthorized' });
  expect(body).not.toHaveProperty('credentialId');
  expect(body).not.toHaveProperty('setupStatus');
  expect(body).not.toHaveProperty('buildGeneration');
}

describe('BYOC Vercel organization enrollment route', () => {
  it("returns only the requested organization's enrollment", async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization(
      `byoc-enrollment-${randomUUID()}`,
      owner.id,
      0
    );
    const otherOrganization = await createTestOrganization(
      `byoc-enrollment-${randomUUID()}`,
      owner.id,
      0
    );
    const enrollment = await enrollOrganization(organization.id);
    const otherEnrollment = await enrollOrganization(otherOrganization.id);
    const personalEnrollment = await enrollUser(owner.id);

    const response = await GET(request(organization.id, authorized), {
      params: Promise.resolve({ organizationId: organization.id }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      credentialId: enrollment.id,
      organizationId: organization.id,
      setupStatus: 'building',
      setupStep: 'install_node_dependencies',
      setupError: null,
      buildGeneration: enrollment.build_generation,
      runtimeBuildId: 'build-1',
      teamSlug: 'team-slug',
      projectSlug: 'project-slug',
    });
    expect(body.credentialId).not.toBe(otherEnrollment.id);
    expect(body.credentialId).not.toBe(personalEnrollment.id);
  });

  it('answers an organization without a Vercel enrollment with 404', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization(
      `byoc-enrollment-${randomUUID()}`,
      owner.id,
      0
    );
    await enrollUser(owner.id);

    const response = await GET(request(organization.id, authorized), {
      params: Promise.resolve({ organizationId: organization.id }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Credential not found' });
  });

  it('refuses the shared internal secret and a request without a credential', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization(
      `byoc-enrollment-${randomUUID()}`,
      owner.id,
      0
    );
    await enrollOrganization(organization.id);

    const sharedSecret = await GET(
      request(organization.id, { 'x-internal-api-key': INTERNAL_API_SECRET }),
      { params: Promise.resolve({ organizationId: organization.id }) }
    );
    expect(sharedSecret.status).toBe(401);
    expect(sharedSecret.headers.get('cache-control')).toBe('no-store');
    expectNoEnrollmentFields(await sharedSecret.json());

    const anonymous = await GET(request(organization.id), {
      params: Promise.resolve({ organizationId: organization.id }),
    });
    expect(anonymous.status).toBe(401);
    expectNoEnrollmentFields(await anonymous.json());
  });
});
