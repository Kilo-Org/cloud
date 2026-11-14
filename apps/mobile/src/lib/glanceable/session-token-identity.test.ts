import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_STORE_CLASS_MARKER } from '@/lib/auth/secure-store-gated';

import {
  _resetSessionTokenIdentityForTests,
  _setSessionTokenIdentityStoreForTests,
  forgetSessionTokenIdentity,
  readSessionTokenIdentities,
  readSessionTokenIdentity,
  rememberSessionTokenIdentity,
  retireSessionTokenIdentities,
} from './session-token-identity';
import { SESSION_TOKEN_IDENTITY_KEY } from './widget-store';

/**
 * The tokens each followed session's row was written with. What is under test
 * is that a release can name its row after Expo rotated the device token, which
 * needs the record to outlive the process and to stay scoped to its account.
 */

const CTX = { userId: 'user-1', organizationId: 'org-1' };
const STORED_AT = 'ExponentPushToken[stored]';

const stored = new Map<string, string>();
let readsFail = false;
const store = {
  getItemAsync: async (key: string) => {
    await Promise.resolve();
    if (readsFail) {
      throw new Error('keychain unavailable');
    }
    return stored.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    await Promise.resolve();
    stored.set(key, value);
  },
};

/** A fresh process: the module's memory is gone, the store is not. */
function restart() {
  _resetSessionTokenIdentityForTests();
  _setSessionTokenIdentityStoreForTests(store);
}

beforeEach(() => {
  stored.clear();
  stored.set(WIDGET_STORE_CLASS_MARKER.key, WIDGET_STORE_CLASS_MARKER.value);
  readsFail = false;
  _resetSessionTokenIdentityForTests();
  _setSessionTokenIdentityStoreForTests(store);
});

/** Answer once the remembered write has landed in the store. */
async function settled(token: string) {
  await vi.waitFor(() => {
    expect(stored.get(SESSION_TOKEN_IDENTITY_KEY) ?? '').toContain(token);
  });
}

describe('session token identities', () => {
  it('answers the token a row was written with after a restart', async () => {
    rememberSessionTokenIdentity('session-1', CTX, STORED_AT);
    await settled(STORED_AT);

    restart();

    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([STORED_AT]);
  });

  it('keeps every token of a rotation, newest last, bounded', async () => {
    for (const token of ['one', 'two', 'three', 'four']) {
      rememberSessionTokenIdentity('session-1', CTX, token);
    }
    await settled('four');

    expect(await readSessionTokenIdentities('session-1', null)).toEqual(['two', 'three', 'four']);

    restart();

    expect(await readSessionTokenIdentities('session-1', null)).toEqual(['two', 'three', 'four']);
  });

  it('answers nothing for another account', async () => {
    rememberSessionTokenIdentity('session-1', CTX, STORED_AT);

    expect(
      await readSessionTokenIdentities('session-1', { userId: 'user-2', organizationId: 'org-1' })
    ).toEqual([]);
    expect(
      await readSessionTokenIdentities('session-1', { userId: 'user-1', organizationId: null })
    ).toEqual([]);
  });

  it('answers an empty list, never an error, when the store cannot be read', async () => {
    rememberSessionTokenIdentity('session-1', CTX, STORED_AT);
    restart();
    readsFail = true;

    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([]);
  });

  it('answers an empty list for an unparseable record', async () => {
    stored.set(SESSION_TOKEN_IDENTITY_KEY, 'not json');

    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([]);
  });

  it('drops one session, and every session on a teardown', async () => {
    rememberSessionTokenIdentity('session-1', CTX, STORED_AT);
    rememberSessionTokenIdentity('session-2', CTX, 'ExponentPushToken[second]');
    await settled('ExponentPushToken[second]');

    forgetSessionTokenIdentity('session-1');
    await vi.waitFor(() => {
      expect(stored.get(SESSION_TOKEN_IDENTITY_KEY) ?? '').not.toContain(STORED_AT);
    });
    restart();
    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([]);
    expect(await readSessionTokenIdentities('session-2', CTX)).toEqual([
      'ExponentPushToken[second]',
    ]);

    retireSessionTokenIdentities(null, new Set());
    await vi.waitFor(() => {
      expect(stored.get(SESSION_TOKEN_IDENTITY_KEY) ?? '').not.toContain('ExponentPushToken');
    });
    restart();
    expect(await readSessionTokenIdentities('session-2', CTX)).toEqual([]);
  });

  it('keeps the newest sessions only', async () => {
    for (let index = 0; index < 34; index += 1) {
      rememberSessionTokenIdentity(
        `session-${String(index)}`,
        CTX,
        `ExponentPushToken[${String(index)}]`
      );
    }
    await settled('ExponentPushToken[33]');

    restart();

    expect(await readSessionTokenIdentities('session-0', CTX)).toEqual([]);
    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([]);
    expect(await readSessionTokenIdentities('session-33', CTX)).toEqual(['ExponentPushToken[33]']);
  });

  it('keeps a persisted token when the same session is registered again after a restart', async () => {
    rememberSessionTokenIdentity('session-1', CTX, 'ExponentPushToken[persisted]');
    await settled('ExponentPushToken[persisted]');

    /* A restart, then the restore re-registers the follow with the rotated
       token. The record must hold both: the row may exist under either. */
    restart();
    rememberSessionTokenIdentity('session-1', CTX, 'ExponentPushToken[rotated]');

    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([
      'ExponentPushToken[persisted]',
      'ExponentPushToken[rotated]',
    ]);

    await vi.waitFor(() => {
      expect(stored.get(SESSION_TOKEN_IDENTITY_KEY) ?? '').toContain(
        'ExponentPushToken[persisted]'
      );
    });
    restart();
    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([
      'ExponentPushToken[persisted]',
      'ExponentPushToken[rotated]',
    ]);
  });

  it('does not merge a record that belongs to another account', async () => {
    rememberSessionTokenIdentity('session-1', CTX, 'ExponentPushToken[persisted]');
    await settled('ExponentPushToken[persisted]');

    restart();
    const other = { userId: 'user-2', organizationId: null };
    rememberSessionTokenIdentity('session-1', other, 'ExponentPushToken[other]');

    expect(await readSessionTokenIdentities('session-1', other)).toEqual([
      'ExponentPushToken[other]',
    ]);
    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([]);
  });

  it('retires only the version it read, leaving a newer record in place', async () => {
    rememberSessionTokenIdentity('session-1', CTX, 'ExponentPushToken[first]');
    const read = await readSessionTokenIdentity('session-1', CTX);
    if (read === null) {
      throw new Error('the recorded identity must be readable');
    }

    // A re-follow records its own identity for the same session.
    rememberSessionTokenIdentity('session-1', CTX, 'ExponentPushToken[second]');
    await settled('ExponentPushToken[second]');
    forgetSessionTokenIdentity('session-1', read.version);

    expect(await readSessionTokenIdentities('session-1', CTX)).toEqual([
      'ExponentPushToken[first]',
      'ExponentPushToken[second]',
    ]);
    restart();
    expect(await readSessionTokenIdentities('session-1', CTX)).toContain(
      'ExponentPushToken[second]'
    );
  });
});
