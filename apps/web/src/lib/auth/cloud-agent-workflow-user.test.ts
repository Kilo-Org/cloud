import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { generateCloudAgentWorkflowToken } from '@/lib/tokens';
import { prepareCloudAgentWorkflowUser } from './cloud-agent-workflow-user';

const issuance = { enabled: true };
jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  isResourceTokenIssuanceEnabled: () => issuance.enabled,
}));

beforeEach(() => {
  issuance.enabled = true;
});

test('preserves a null pepper and issues modern review admission with the persisted value', async () => {
  const user = await insertTestUser({ api_token_pepper: null });
  const prepared = await prepareCloudAgentWorkflowUser(user);
  const [persisted] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
  expect(prepared.api_token_pepper).toBeNull();
  expect(prepared.api_token_pepper).toBe(persisted.api_token_pepper);
  const claims = jwt.decode(
    generateCloudAgentWorkflowToken(prepared, { tokenSource: 'code-review', expiresIn: 3600 })
  );
  expect(claims).toMatchObject({
    aud: 'cloud-agent-next',
    tokenPurpose: 'internal-service',
    credentialExchange: false,
    apiTokenPepper: persisted.api_token_pepper,
    runtimeAdmission: {
      source: 'automation',
      authorizationUserId: user.id,
      authorizationPepper: persisted.api_token_pepper,
    },
  });
});

test('concurrent preparations preserve the persisted null pepper', async () => {
  const user = await insertTestUser({ api_token_pepper: null });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => prepareCloudAgentWorkflowUser(user))
  );
  expect(new Set(results.map(result => result.api_token_pepper)).size).toBe(1);
  expect(results[0].api_token_pepper).toBeNull();
});

test('preserves a pepper assigned after the user snapshot was loaded', async () => {
  const user = await insertTestUser({ api_token_pepper: null });
  await db
    .update(kilocode_users)
    .set({ api_token_pepper: 'concurrent-rotation' })
    .where(eq(kilocode_users.id, user.id));
  expect((await prepareCloudAgentWorkflowUser(user)).api_token_pepper).toBe('concurrent-rotation');
});

test('preserves existing peppers and leaves legacy issuance unchanged', async () => {
  const existing = await insertTestUser({ api_token_pepper: 'existing-pepper' });
  expect(await prepareCloudAgentWorkflowUser(existing)).toBe(existing);
  issuance.enabled = false;
  const user = await insertTestUser({ api_token_pepper: null });
  expect(await prepareCloudAgentWorkflowUser(user)).toBe(user);
  const [persisted] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
  expect(persisted.api_token_pepper).toBeNull();
});

test('fails closed if the user was deleted', async () => {
  const user = await insertTestUser({ api_token_pepper: null });
  await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
  await expect(prepareCloudAgentWorkflowUser(user)).rejects.toThrow('not found');
});
