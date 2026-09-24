// The cookie store is stubbed so the signed linking session can round-trip
// without a request context.
jest.mock('next/headers', () => {
  const store = new Map<string, string>();
  return {
    cookies: async () => ({
      set: (name: string, value: string) => store.set(name, value),
      get: (name: string) => (store.has(name) ? { value: store.get(name) } : undefined),
      delete: (name: string) => store.delete(name),
    }),
  };
});

import { describe, expect, it } from '@jest/globals';
import { createAccountLinkingSession, getAccountLinkingSession } from './account-linking-session';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

describe('account linking session', () => {
  it('carries the shared-services scope through the signed session', async () => {
    await createAccountLinkingSession('user-1', 'openai', ORGANIZATION_ID, 'shared_services');

    await expect(getAccountLinkingSession()).resolves.toMatchObject({
      existingUserId: 'user-1',
      targetProvider: 'openai',
      organizationId: ORGANIZATION_ID,
      chatGptScope: 'shared_services',
    });
  });

  it('carries an organization member link without the shared-services scope', async () => {
    await createAccountLinkingSession('user-1', 'openai', ORGANIZATION_ID);

    const session = await getAccountLinkingSession();

    expect(session?.organizationId).toBe(ORGANIZATION_ID);
    expect(session?.chatGptScope).toBeUndefined();
  });
});
