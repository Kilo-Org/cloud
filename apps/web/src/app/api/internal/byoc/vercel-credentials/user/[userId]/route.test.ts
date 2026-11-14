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

async function enroll(userId: string) {
  const [row] = await db
    .insert(byoc_connections)
    .values({
      id: randomUUID(),
      provider: 'vercel',
      user_id: userId,
      organization_id: null,
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

function request(userId: string, headers?: Record<string, string>) {
  return new NextRequest(`http://localhost/api/internal/byoc/vercel-credentials/user/${userId}`, {
    method: 'GET',
    ...(headers ? { headers } : {}),
  });
}

function expectNoEnrollmentFields(body: unknown) {
  expect(body).toEqual({ error: 'Unauthorized' });
  expect(body).not.toHaveProperty('credentialId');
  expect(body).not.toHaveProperty('setupStatus');
  expect(body).not.toHaveProperty('buildGeneration');
}

describe('BYOC Vercel user enrollment route', () => {
  it("returns only the requested user's enrollment", async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    const enrollment = await enroll(user.id);
    const otherEnrollment = await enroll(otherUser.id);

    const response = await GET(request(user.id, authorized), {
      params: Promise.resolve({ userId: user.id }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      credentialId: enrollment.id,
      userId: user.id,
      setupStatus: 'building',
      setupStep: 'install_node_dependencies',
      setupError: null,
      buildGeneration: enrollment.build_generation,
      runtimeBuildId: 'build-1',
      teamSlug: 'team-slug',
      projectSlug: 'project-slug',
    });
    expect(body.credentialId).not.toBe(otherEnrollment.id);
  });

  it('refuses the shared internal secret and a request without a credential', async () => {
    const user = await insertTestUser();
    await enroll(user.id);

    const sharedSecret = await GET(
      request(user.id, { 'x-internal-api-key': INTERNAL_API_SECRET }),
      { params: Promise.resolve({ userId: user.id }) }
    );
    expect(sharedSecret.status).toBe(401);
    expect(sharedSecret.headers.get('cache-control')).toBe('no-store');
    expectNoEnrollmentFields(await sharedSecret.json());

    const anonymous = await GET(request(user.id), {
      params: Promise.resolve({ userId: user.id }),
    });
    expect(anonymous.status).toBe(401);
    expectNoEnrollmentFields(await anonymous.json());
  });
});
