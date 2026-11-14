import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import {
  BYOC_INTERNAL_API_SECRET,
  INTERNAL_API_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import { GET as getCredential, PATCH as updateCredential } from './[credentialId]/route';
import { GET as getOrganization } from './organization/[organizationId]/route';
import { GET as getUser } from './user/[userId]/route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  BYOC_INTERNAL_API_SECRET: '',
}));

const credentialId = randomUUID();
const userId = 'user-without-enrollment';
const organizationId = randomUUID();
const credentialParams = { params: Promise.resolve({ credentialId }) };

function credentialRequest(path: string, headers: Record<string, string>) {
  return new NextRequest(`http://localhost/api/internal/byoc/vercel-credentials/${path}`, {
    method: 'GET',
    headers,
  });
}

describe('BYOC Vercel credential routes without a configured credential', () => {
  it('treats an unset dedicated credential as refusing every request', async () => {
    expect(BYOC_INTERNAL_API_SECRET).toBe('');

    const presentations: Record<string, string>[] = [
      {},
      { 'x-internal-api-key': '' },
      { 'x-internal-api-key': INTERNAL_API_SECRET },
      { 'x-internal-api-key': 'any-other-value' },
    ];

    for (const headers of presentations) {
      const credential = await getCredential(
        credentialRequest(`${credentialId}?userId=${userId}`, headers),
        credentialParams
      );
      expect(credential.status).toBe(401);
      expect(await credential.json()).toEqual({ error: 'Unauthorized' });

      const user = await getUser(credentialRequest(`user/${userId}`, headers), {
        params: Promise.resolve({ userId }),
      });
      expect(user.status).toBe(401);
      expect(await user.json()).toEqual({ error: 'Unauthorized' });

      const organization = await getOrganization(
        credentialRequest(`organization/${organizationId}`, headers),
        { params: Promise.resolve({ organizationId }) }
      );
      expect(organization.status).toBe(401);
      expect(await organization.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('refuses a status update when the dedicated credential is unset', async () => {
    const response = await updateCredential(
      new NextRequest(`http://localhost/api/internal/byoc/vercel-credentials/${credentialId}`, {
        method: 'PATCH',
        headers: {
          'x-internal-api-key': INTERNAL_API_SECRET,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      }),
      credentialParams
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
});
