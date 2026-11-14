import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { byoc_connections, type ByocConnection } from '@kilocode/db/schema';
import type { VercelComputeCredentialEnvelope } from '@kilocode/db/schema-types';
import {
  BYOC_INTERNAL_API_SECRET,
  INTERNAL_API_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET, PATCH } from './route';

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

async function insertCredential(owner: { userId: string } | { organizationId: string }) {
  const [row] = await db
    .insert(byoc_connections)
    .values({
      id: randomUUID(),
      provider: 'vercel',
      user_id: 'userId' in owner ? owner.userId : null,
      organization_id: 'organizationId' in owner ? owner.organizationId : null,
      credentials_encrypted: credentialEnvelope,
      config: {
        token_scope: 'team',
        team_id: 'team_test',
        project_id: 'prj_test',
        team_slug: 'team-slug',
        project_slug: 'project-slug',
      },
    })
    .returning();
  if (!row) throw new Error('Missing credential fixture');
  return row;
}

async function personalCredential() {
  const user = await insertTestUser();
  return { user, row: await insertCredential({ userId: user.id }) };
}

async function organizationCredential() {
  const owner = await insertTestUser();
  const organization = await createTestOrganization(`byoc-credential-${randomUUID()}`, owner.id, 0);
  return { organization, row: await insertCredential({ organizationId: organization.id }) };
}

function getRequest(
  credentialId: string,
  query: URLSearchParams,
  headers: Record<string, string> = authorized
) {
  return new NextRequest(
    `http://localhost/api/internal/byoc/vercel-credentials/${credentialId}?${query.toString()}`,
    { method: 'GET', headers }
  );
}

function patchRequest(
  credentialId: string,
  body: unknown,
  headers: Record<string, string> = authorized
) {
  return new NextRequest(`http://localhost/api/internal/byoc/vercel-credentials/${credentialId}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function updateBody(
  row: ByocConnection,
  owner: { userId: string } | { organizationId: string },
  overrides: Record<string, unknown> = {}
) {
  return {
    buildGeneration: row.build_generation,
    setupStatus: 'building',
    setupStep: 'install_node_dependencies',
    setupError: null,
    teamSlug: 'team-slug',
    projectSlug: 'project-slug',
    runtimeBuildId: 'build-1',
    runtimeSnapshotId: null,
    setupStartedAt: null,
    setupCompletedAt: null,
    ...owner,
    ...overrides,
  };
}

function credentialParams(credentialId: string) {
  return { params: Promise.resolve({ credentialId }) };
}

async function storedRow(credentialId: string) {
  const row = await db.query.byoc_connections.findFirst({
    where: eq(byoc_connections.id, credentialId),
  });
  if (!row) throw new Error('Missing stored credential');
  return row;
}

function expectNoCredentialFields(body: unknown) {
  expect(body).toEqual({ error: 'Unauthorized' });
  expect(body).not.toHaveProperty('tokenEncrypted');
  expect(body).not.toHaveProperty('credentialId');
  expect(body).not.toHaveProperty('teamSlug');
}

describe('BYOC Vercel credential route', () => {
  it('returns the personal credential to its owner', async () => {
    const { user, row } = await personalCredential();
    const response = await GET(
      getRequest(row.id, new URLSearchParams({ userId: user.id })),
      credentialParams(row.id)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      credentialId: row.id,
      userId: user.id,
      teamSlug: 'team-slug',
      projectSlug: 'project-slug',
      buildGeneration: row.build_generation,
      setupStatus: 'pending',
    });
    expect(body.tokenEncrypted).toEqual(credentialEnvelope);
  });

  it('returns the organization credential to its owner', async () => {
    const { organization, row } = await organizationCredential();
    const response = await GET(
      getRequest(row.id, new URLSearchParams({ organizationId: organization.id })),
      credentialParams(row.id)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      credentialId: row.id,
      organizationId: organization.id,
      teamSlug: 'team-slug',
    });
  });

  it('refuses requests that do not present the dedicated BYOC credential', async () => {
    const { user, row } = await personalCredential();
    const query = new URLSearchParams({ userId: user.id });
    const rejected: { label: string; headers: Record<string, string> }[] = [
      { label: 'no header', headers: {} },
      { label: 'a wrong value', headers: { 'x-internal-api-key': 'wrong-secret' } },
      {
        label: 'the shared internal secret',
        headers: { 'x-internal-api-key': INTERNAL_API_SECRET },
      },
    ];

    for (const { headers } of rejected) {
      const getResponse = await GET(getRequest(row.id, query, headers), credentialParams(row.id));
      expect(getResponse.status).toBe(401);
      expect(getResponse.headers.get('cache-control')).toBe('no-store');
      expectNoCredentialFields(await getResponse.json());

      const patchResponse = await PATCH(
        patchRequest(row.id, updateBody(row, { userId: user.id }), headers),
        credentialParams(row.id)
      );
      expect(patchResponse.status).toBe(401);
      expect(patchResponse.headers.get('cache-control')).toBe('no-store');
      expectNoCredentialFields(await patchResponse.json());
    }
  });

  it('leaves the stored credential untouched when a PATCH is refused', async () => {
    const { user, row } = await personalCredential();
    const before = await storedRow(row.id);

    const response = await PATCH(
      patchRequest(row.id, updateBody(row, { userId: user.id }), {
        'x-internal-api-key': INTERNAL_API_SECRET,
      }),
      credentialParams(row.id)
    );

    expect(response.status).toBe(401);
    expect(await storedRow(row.id)).toEqual(before);
  });

  it('answers a foreign owner or an unknown credential with 404', async () => {
    const { row } = await personalCredential();
    const outsider = await insertTestUser();

    const foreignOwner = await GET(
      getRequest(row.id, new URLSearchParams({ userId: outsider.id })),
      credentialParams(row.id)
    );
    expect(foreignOwner.status).toBe(404);
    expect(await foreignOwner.json()).toEqual({ error: 'Credential not found' });

    const unknownCredentialId = randomUUID();
    const unknownCredential = await GET(
      getRequest(unknownCredentialId, new URLSearchParams({ userId: outsider.id })),
      credentialParams(unknownCredentialId)
    );
    expect(unknownCredential.status).toBe(404);
    expect(await unknownCredential.json()).toEqual({ error: 'Credential not found' });
  });

  it('ignores a status update carrying a stale build generation', async () => {
    const { user, row } = await personalCredential();
    const before = await storedRow(row.id);

    const response = await PATCH(
      patchRequest(row.id, updateBody(row, { userId: user.id }, { buildGeneration: randomUUID() })),
      credentialParams(row.id)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: false });
    expect(await storedRow(row.id)).toEqual(before);
  });

  it('projects a fenced status update into the stored credential', async () => {
    const { organization, row } = await organizationCredential();

    const response = await PATCH(
      patchRequest(
        row.id,
        updateBody(
          row,
          { organizationId: organization.id },
          { buildGeneration: row.build_generation }
        )
      ),
      credentialParams(row.id)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ updated: true });

    const stored = await storedRow(row.id);
    expect(stored).toMatchObject({
      id: row.id,
      organization_id: organization.id,
      setup_status: 'building',
      setup_step: 'install_node_dependencies',
      setup_error: null,
      build_generation: row.build_generation,
    });
    expect(stored.config).toMatchObject({
      team_slug: 'team-slug',
      project_slug: 'project-slug',
    });
    expect(stored.runtime).toMatchObject({ runtime_build_id: 'build-1' });

    const read = await GET(
      getRequest(row.id, new URLSearchParams({ organizationId: organization.id })),
      credentialParams(row.id)
    );
    expect(await read.json()).toMatchObject({
      setupStatus: 'building',
      setupStep: 'install_node_dependencies',
      teamSlug: 'team-slug',
      projectSlug: 'project-slug',
      runtimeBuildId: 'build-1',
    });
  });
});
