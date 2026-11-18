const jar = new Map<string, string>();

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  NEXTAUTH_URL: 'https://app.example.test',
}));

import { PENDING_LINK_COOKIE, readPendingLinkSecret, setPendingLinkCookie } from './pending-link';

describe('pending link cookie under HTTPS', () => {
  beforeEach(() => jar.clear());

  it('uses the host-only cookie name', () => {
    expect(PENDING_LINK_COOKIE).toBe('__Host-pending-auth-link');
  });

  it('ignores a secret planted under the unprefixed name', async () => {
    jar.set('pending-auth-link', 'planted-secret');

    await expect(readPendingLinkSecret()).resolves.toBeNull();
  });

  it('reads the secret it set', async () => {
    await setPendingLinkCookie('own-secret');

    await expect(readPendingLinkSecret()).resolves.toBe('own-secret');
  });
});
