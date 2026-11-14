import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_EMAIL_DRAFT_KEY, LOGIN_SSO_RECOVERY_DRAFT_KEY } from '@/lib/storage-keys';

import type * as LoginDraftModule from './login-draft';

import {
  _resetLoginDraftForTests,
  beginLoginEmail,
  endLoginAttempt,
  holdLoginEmail,
  holdSsoRecovery,
  persistLoginDrafts,
  restoreLoginDrafts,
} from './login-draft';

/**
 * The sign-in drafts, and the retirement a completed sign-in leaves behind.
 *
 * What is worth proving is that the previous attempt cannot come back: the
 * person's address is a temporary convenience, so it must survive a language
 * reload and must never survive a successful sign-in, whatever a keychain write
 * does on the way.
 */

const stored = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failingWrites: 0,
}));

vi.mock('@/lib/auth/secure-store', () => ({
  getItemAsync: async (key: string) => {
    await Promise.resolve();
    return stored.values.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    await Promise.resolve();
    if (stored.failingWrites > 0) {
      stored.failingWrites -= 1;
      throw new Error('keychain unavailable');
    }
    stored.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    await Promise.resolve();
    stored.values.delete(key);
  },
}));

/** A fresh app process: the module's memory is gone, the keychain is not. */
function reload(): Promise<typeof LoginDraftModule> {
  vi.resetModules();
  return import('./login-draft');
}

beforeEach(() => {
  stored.values.clear();
  stored.failingWrites = 0;
  _resetLoginDraftForTests();
});

describe('a sign-in attempt', () => {
  it('retires the disk copy across a module reload, even after a failed write', async () => {
    beginLoginEmail('a@b.c');
    /* The first write fails — a locked or unhappy keychain — so the copy never
       lands. The retirement is a write of its own, so it does not depend on it. */
    stored.failingWrites = 1;
    await expect(persistLoginDrafts()).rejects.toThrow('keychain unavailable');

    await endLoginAttempt();

    const reloaded = await reload();
    await expect(reloaded.restoreLoginDrafts()).resolves.toEqual({ email: '', ssoRecovery: null });
  });

  it('retires the held copy across a restart when the tombstone write fails once', async () => {
    beginLoginEmail('a@b.c');
    /* The copy is on disk, so a retirement that is only attempted leaves the
       old held record restorable by the next cold start. */
    await persistLoginDrafts();
    stored.failingWrites = 1;

    await endLoginAttempt();

    const reloaded = await reload();
    await expect(reloaded.restoreLoginDrafts()).resolves.toEqual({ email: '', ssoRecovery: null });
  });

  it('rejects a completion whose retirement cannot be written at all', async () => {
    beginLoginEmail('a@b.c');
    await persistLoginDrafts();
    stored.failingWrites = 99;

    // The retirement is part of completing the sign-in, so its failure is not
    // swallowed: the completion can be retried.
    await expect(endLoginAttempt()).rejects.toThrow('keychain unavailable');
    // This process still has no attempt to restore, whatever the keychain did.
    await expect(restoreLoginDrafts()).resolves.toEqual({ email: '', ssoRecovery: null });
  });

  it('does not overwrite a saved draft from a mount that unmounts before restoration', async () => {
    beginLoginEmail('typed@b.c');
    await persistLoginDrafts();

    /* A fresh process: the field is blank until the restore answers, and the
       screen's unmount persists what it holds — before the restore has run. */
    const reloaded = await reload();
    await reloaded.persistLoginDrafts();

    await expect(reloaded.restoreLoginDrafts()).resolves.toEqual({
      email: 'typed@b.c',
      ssoRecovery: null,
    });
    // The remount's own unmount writes the restored attempt, not blanks.
    await reloaded.persistLoginDrafts();
    const again = await reload();
    await expect(again.restoreLoginDrafts()).resolves.toEqual({
      email: 'typed@b.c',
      ssoRecovery: null,
    });
  });

  it('persists an address typed before restoration answered', async () => {
    beginLoginEmail('typed-before@b.c');

    const reloaded = await reload();
    reloaded.beginLoginEmail('typed-before@b.c');
    await reloaded.persistLoginDrafts();

    const again = await reload();
    await expect(again.restoreLoginDrafts()).resolves.toEqual({
      email: 'typed-before@b.c',
      ssoRecovery: null,
    });
  });

  it('does not reopen a retired attempt from a passive mount', async () => {
    beginLoginEmail('a@b.c');
    await persistLoginDrafts();
    await endLoginAttempt();

    // The login screen seeds what it restored, and its banner effect clears a
    // banner on every mount: neither is a person typing an address.
    holdLoginEmail('restored@b.c');
    holdSsoRecovery(null);

    await expect(restoreLoginDrafts()).resolves.toEqual({ email: '', ssoRecovery: null });

    const reloaded = await reload();
    await expect(reloaded.restoreLoginDrafts()).resolves.toEqual({ email: '', ssoRecovery: null });
  });

  it('keeps the typed address across a language reload', async () => {
    beginLoginEmail('typed@b.c');
    holdSsoRecovery({ email: 'typed@b.c', ssoOrganizationId: 'org-1' });
    await persistLoginDrafts();

    const reloaded = await reload();

    await expect(reloaded.restoreLoginDrafts()).resolves.toEqual({
      email: 'typed@b.c',
      ssoRecovery: { email: 'typed@b.c', ssoOrganizationId: 'org-1' },
    });
  });

  it('holds the address the form already typed over the stored one', async () => {
    beginLoginEmail('typed@b.c');
    await persistLoginDrafts();
    const reloaded = await reload();
    reloaded.beginLoginEmail('newer@b.c');

    await expect(reloaded.restoreLoginDrafts()).resolves.toEqual({
      email: 'newer@b.c',
      ssoRecovery: null,
    });
  });

  it('deletes a legacy key and never restores it', async () => {
    stored.values.set(LOGIN_EMAIL_DRAFT_KEY, 'legacy@b.c');
    stored.values.set(
      LOGIN_SSO_RECOVERY_DRAFT_KEY,
      JSON.stringify({ email: 'legacy@b.c', ssoOrganizationId: 'org-1' })
    );

    await expect(restoreLoginDrafts()).resolves.toEqual({ email: '', ssoRecovery: null });
    expect(stored.values.has(LOGIN_EMAIL_DRAFT_KEY)).toBe(false);
    expect(stored.values.has(LOGIN_SSO_RECOVERY_DRAFT_KEY)).toBe(false);
  });

  it('holds a followed invite as the address of a new attempt', async () => {
    await endLoginAttempt();

    holdSsoRecovery({ email: 'invited@b.c', ssoOrganizationId: 'org-1' });

    await expect(restoreLoginDrafts()).resolves.toEqual({
      email: 'invited@b.c',
      ssoRecovery: { email: 'invited@b.c', ssoOrganizationId: 'org-1' },
    });
  });
});
