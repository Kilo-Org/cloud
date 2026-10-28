import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLoginDrafts,
  restoreLoginDrafts,
  setLoginEmailDraft,
  setSsoRecoveryDraft,
} from './login-draft';

const stored = vi.hoisted(() => ({
  email: null as string | null,
  sso: null as string | null,
}));

vi.mock('@/lib/auth/secure-store', () => ({
  getItemAsync: vi.fn((key: string) =>
    Promise.resolve(key.includes('sso') ? stored.sso : stored.email)
  ),
  setItemAsync: vi.fn(() => Promise.resolve()),
  deleteItemAsync: vi.fn(() => Promise.resolve()),
}));

describe('login drafts across a remount', () => {
  beforeEach(() => {
    stored.email = null;
    stored.sso = null;
    clearLoginDrafts();
  });

  it('keeps the drafts the form is holding in memory', async () => {
    setLoginEmailDraft('typed@example.com');
    setSsoRecoveryDraft({ email: 'typed@example.com', ssoOrganizationId: 'org-1' });
    stored.email = 'older@example.com';

    await expect(restoreLoginDrafts()).resolves.toEqual({
      email: 'typed@example.com',
      ssoRecovery: { email: 'typed@example.com', ssoOrganizationId: 'org-1' },
    });
  });

  it('falls back to the stored drafts when the form holds none', async () => {
    stored.email = 'stored@example.com';
    stored.sso = JSON.stringify({ email: 'stored@example.com', ssoOrganizationId: 'org-2' });

    await expect(restoreLoginDrafts()).resolves.toEqual({
      email: 'stored@example.com',
      ssoRecovery: { email: 'stored@example.com', ssoOrganizationId: 'org-2' },
    });
  });

  it('ignores a corrupt stored draft instead of failing the mount', async () => {
    stored.sso = '{not json';

    await expect(restoreLoginDrafts()).resolves.toEqual({ email: '', ssoRecovery: null });
  });
});
