import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { GET as getCloudAgentBalance } from '@/app/api/cloud-agent-next/balance/route';
import { GET as getBalance } from '@/app/api/profile/balance/route';
import { getUserFromAuth } from '@/lib/user/server';
import {
  generateApiToken,
  generateWorkflowGatewayToken,
  generateCloudAgentWorkflowToken,
} from '@/lib/tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { prepareCloudAgentWorkflowUser } from './cloud-agent-workflow-user';

// Request lifecycle scheduling is supplied by Next.js in production.
jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

const mockHeaders = jest.fn<Promise<Headers>, []>();
jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));
jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  isResourceTokenIssuanceEnabled: () => true,
}));

test('preparing modern workflows preserves authentication for an existing null-pepper CLI token', async () => {
  const user = await insertTestUser({ api_token_pepper: null });
  const token = generateApiToken(user, { createdOnPlatform: 'cli' });
  mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

  const before = await getUserFromAuth({ adminOnly: false });
  expect(before.authFailedResponse).toBeNull();
  expect(before.user?.id).toBe(user.id);

  await prepareCloudAgentWorkflowUser(user);

  const after = await getUserFromAuth({ adminOnly: false });
  expect({
    userId: after.user?.id,
    status: after.authFailedResponse?.status ?? null,
    body: after.authFailedResponse ? await after.authFailedResponse.json() : null,
  }).toEqual({ userId: user.id, status: null, body: null });
});

test('null-pepper modern credentials enforce audiences and genuine rotation revokes every old credential', async () => {
  const user = await insertTestUser({ api_token_pepper: null });
  const cliToken = generateApiToken(user, { createdOnPlatform: 'cli' });
  const prepared = await prepareCloudAgentWorkflowUser(user);
  expect(prepared.api_token_pepper).toBeNull();
  const gatewayToken = generateWorkflowGatewayToken(prepared, { tokenSource: 'reviewer' });
  const controlToken = generateCloudAgentWorkflowToken(prepared, {
    tokenSource: 'reviewer',
    expiresIn: 3600,
  });

  for (const [token, audience, purpose] of [
    [gatewayToken, 'kilo-gateway', 'delegated-workload'],
    [controlToken, 'cloud-agent-next', 'internal-service'],
  ]) {
    const claims = jwt.verify(token, NEXTAUTH_SECRET);
    expect(claims).toMatchObject({
      aud: audience,
      apiTokenPepper: null,
      tokenPurpose: purpose,
      credentialExchange: false,
    });
    if (audience === 'cloud-agent-next') {
      expect(claims).toMatchObject({ runtimeAdmission: { authorizationPepper: null } });
    }
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));
    const accepted = await getUserFromAuth({ adminOnly: false, expectedAudience: audience });
    expect(accepted.authFailedResponse).toBeNull();
    expect(accepted.user?.id).toBe(user.id);
    const wrongAudience = await getUserFromAuth({ adminOnly: false });
    expect(wrongAudience.authFailedResponse?.status).toBe(401);
  }

  mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${controlToken}` }));
  expect((await getCloudAgentBalance()).status).toBe(200);
  expect((await getBalance()).status).toBe(401);
  mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${gatewayToken}` }));
  expect((await getCloudAgentBalance()).status).toBe(401);

  mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${cliToken}` }));
  const balance = await getBalance();
  expect(balance.status).toBe(200);
  expect(await balance.json()).toEqual({ balance: 0, isDepleted: true });

  await db
    .update(kilocode_users)
    .set({ api_token_pepper: 'explicit-test-rotation' })
    .where(eq(kilocode_users.id, user.id));

  for (const [token, expectedAudience] of [
    [cliToken, 'kilo-api'],
    [gatewayToken, 'kilo-gateway'],
    [controlToken, 'cloud-agent-next'],
  ]) {
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));
    const revoked = await getUserFromAuth({ adminOnly: false, expectedAudience });
    expect(revoked.user).toBeNull();
    expect(revoked.authFailedResponse?.status).toBe(401);
  }
  mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${cliToken}` }));
  expect((await getBalance()).status).toBe(401);
  mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${controlToken}` }));
  expect((await getCloudAgentBalance()).status).toBe(401);
});
