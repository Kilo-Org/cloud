/* eslint-disable max-lines -- cohesive unit suite for the encrypted-kv open/recovery contract, key validation, and KV behavior */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake native methods and vi.fn factories settle without await because node:sqlite calls are synchronous */
// eslint-disable-next-line import/no-nodejs-modules -- node:sqlite is the only way to run real SQL semantics in a node test; the expo-sqlite native module cannot load here
import { DatabaseSync } from 'node:sqlite';
import * as Sentry from '@sentry/react-native';
import * as Crypto from 'expo-crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native modules cannot run in a node test, so they are mocked. The
// expo-sqlite mock is backed by node:sqlite so the SQL statements behave like
// the real engine (LIKE, upsert, primary key), while open/probe/recovery
// behavior is driven by the test seams below.

const store = new Map<string, string>();
const execLog: string[] = [];
let randomCallCount = 0;
let failNextProbe = false;
let failEveryProbe = false;
let failNextPragma = false;
let failEveryPragma = false;
// Simulates a native build without SQLCipher: `PRAGMA cipher_version` returns
// no row, exactly as plain SQLite does for an unrecognized pragma.
let hasSQLCipher = true;
// Number of exec calls that had happened when `cipher_version` was probed;
// -1 when it was never probed. Proves the probe precedes `PRAGMA key`.
let cipherProbedAtExecCount = -1;
let closeCallCount = 0;

type FakeDatabase = {
  execAsync: (source: string) => Promise<void>;
  getFirstAsync: (
    source: string,
    ...params: (string | number)[]
  ) => Promise<Record<string, unknown> | null>;
  getAllAsync: (
    source: string,
    ...params: (string | number)[]
  ) => Promise<Record<string, unknown>[]>;
  runAsync: (
    source: string,
    ...params: (string | number)[]
  ) => Promise<{ changes: number | bigint; lastInsertRowid: number | bigint }>;
  closeAsync: () => Promise<void>;
};

function createFakeDatabase(): FakeDatabase {
  const native = new DatabaseSync(':memory:');
  return {
    execAsync: async source => {
      execLog.push(source);
      // PRAGMA failure seam: the key call can fail after the handle opened.
      if (source.startsWith('PRAGMA key') && (failEveryPragma || failNextPragma)) {
        failNextPragma = false;
        throw new Error('PRAGMA key failed');
      }
      native.exec(source);
    },
    getFirstAsync: async (source, ...params) => {
      // SQLCipher presence seam. node:sqlite has no `cipher_version` pragma,
      // so the fake answers it directly.
      if (source === 'PRAGMA cipher_version') {
        cipherProbedAtExecCount = execLog.length;
        return hasSQLCipher ? { cipher_version: '4.5.5 community' } : null;
      }
      // Probe failure seam: a wrong key or corrupt file throws at the probe.
      if (source.includes('sqlite_master')) {
        if (failNextProbe) {
          failNextProbe = false;
          throw new Error('file is not a database');
        }
        if (failEveryProbe) {
          throw new Error('file is not a database');
        }
      }
      return native.prepare(source).get(...params) ?? null;
    },
    getAllAsync: async (source, ...params) => native.prepare(source).all(...params),
    runAsync: async (source, ...params) => native.prepare(source).run(...params),
    closeAsync: async () => {
      closeCallCount += 1;
      native.close();
    },
  };
}

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: vi.fn(async (byteCount: number) => {
    const bytes = new Uint8Array(byteCount);
    randomCallCount += 1;
    bytes[0] = randomCallCount;
    return bytes;
  }),
}));

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: vi.fn(async () => createFakeDatabase()),
  deleteDatabaseAsync: vi.fn(async () => undefined),
}));

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

/* eslint-disable import/first */
import * as SQLite from 'expo-sqlite';
import { PERSIST_DB_KEY } from '@/lib/storage-keys';
import {
  clearScope,
  clearScopePrefix,
  getItem,
  isValidDbKey,
  listEntries,
  MissingSQLCipherError,
  removeItem,
  resetEncryptedKvOpenForTests,
  scopeBytes,
  setItem,
  utf8ByteLength,
  validateItemKey,
  validateScope,
} from './encrypted-kv';
/* eslint-enable import/first */

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  execLog.length = 0;
  randomCallCount = 0;
  failNextProbe = false;
  failEveryProbe = false;
  failNextPragma = false;
  failEveryPragma = false;
  hasSQLCipher = true;
  cipherProbedAtExecCount = -1;
  closeCallCount = 0;
  resetEncryptedKvOpenForTests();
});

describe('scope and key validation', () => {
  it('rejects an empty scope on every API', async () => {
    await expect(getItem('', 'k')).rejects.toThrow(TypeError);
    await expect(setItem('', 'k', 'v')).rejects.toThrow(TypeError);
    await expect(removeItem('', 'k')).rejects.toThrow(TypeError);
    await expect(clearScope('')).rejects.toThrow(TypeError);
    await expect(clearScopePrefix('')).rejects.toThrow(TypeError);
    await expect(scopeBytes('')).rejects.toThrow(TypeError);
    await expect(listEntries('')).rejects.toThrow(TypeError);
  });

  it('rejects an empty key', async () => {
    await expect(getItem('s', '')).rejects.toThrow(TypeError);
    await expect(setItem('s', '', 'v')).rejects.toThrow(TypeError);
    await expect(removeItem('s', '')).rejects.toThrow(TypeError);
  });

  it('rejects a non-string value', async () => {
    await expect(setItem('s', 'k', 123 as unknown as string)).rejects.toThrow(TypeError);
  });

  it('validates before opening the database', async () => {
    await expect(getItem('', 'k')).rejects.toThrow(TypeError);
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });

  it('validateScope and validateItemKey reject empty input directly', () => {
    expect(() => {
      validateScope('');
    }).toThrow(TypeError);
    expect(() => {
      validateScope('draft:u1');
    }).not.toThrow();
    expect(() => {
      validateItemKey('s', '');
    }).toThrow(TypeError);
    expect(() => {
      validateItemKey('s', 'agent-composer:new');
    }).not.toThrow();
  });
});

describe('SQLCipher presence', () => {
  it('probes cipher_version before setting the key', async () => {
    await setItem('s', 'a', 'x');
    const keyIndex = execLog.findIndex(source => source.startsWith('PRAGMA key'));
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    // The probe ran while no exec had happened yet, so it precedes the key.
    expect(cipherProbedAtExecCount).toBe(0);
  });

  it('refuses to open a plaintext database when the build has no SQLCipher', async () => {
    hasSQLCipher = false;
    await expect(setItem('s', 'a', 'x')).rejects.toThrow(MissingSQLCipherError);
    // No key is ever set on an unencrypted handle.
    expect(execLog.some(source => source.startsWith('PRAGMA key'))).toBe(false);
  });

  it('never deletes the database when the build has no SQLCipher', async () => {
    hasSQLCipher = false;
    await expect(setItem('s', 'a', 'x')).rejects.toThrow(MissingSQLCipherError);
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalled();
  });
});

describe('single-flight open contract', () => {
  it('opens the database once for concurrent callers', async () => {
    await Promise.all([setItem('s', 'a', 'x'), setItem('s', 'b', 'y')]);
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
    await expect(getItem('s', 'a')).resolves.toBe('x');
    await expect(getItem('s', 'b')).resolves.toBe('y');
  });

  it('reuses the opened database for later calls', async () => {
    await setItem('s', 'a', 'x');
    await setItem('s', 'b', 'y');
    await getItem('s', 'a');
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
  });

  it('generates a 32-byte hex key and stores it in SecureStore on first open', async () => {
    await setItem('s', 'a', 'x');
    const stored = store.get(PERSIST_DB_KEY);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledWith(32);
  });

  it('reuses the stored key across opens instead of generating a new one', async () => {
    await setItem('s', 'a', 'x');
    const first = store.get(PERSIST_DB_KEY);
    resetEncryptedKvOpenForTests();
    await getItem('s', 'a');
    expect(store.get(PERSIST_DB_KEY)).toBe(first);
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
  });

  it('keys the database with the stored hex key via PRAGMA', async () => {
    await setItem('s', 'a', 'x');
    const key = store.get(PERSIST_DB_KEY);
    expect(key).toBeDefined();
    expect(execLog).toContain(`PRAGMA key = "x'${key}'"`);
  });

  it('creates the DEC-01 schema on open', async () => {
    await setItem('s', 'a', 'x');
    const createSql = execLog.find(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS kv'));
    expect(createSql).toContain('PRIMARY KEY (scope, k)');
    expect(createSql).toContain('bytes INTEGER NOT NULL');
  });
});

describe('probe failure recovery', () => {
  it('deletes, regenerates the key, reopens, and reports the reset to Sentry', async () => {
    failNextProbe = true;
    await setItem('s', 'a', 'x');

    expect(SQLite.deleteDatabaseAsync).toHaveBeenCalledWith('kilo-persist.db');
    // A fresh key was generated and stored over the old one.
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(2);
    expect(store.get(PERSIST_DB_KEY)).toMatch(/^02[0-9a-f]{62}$/);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // Only the first handle was closed; the recovery-opened one stays open.
    expect(closeCallCount).toBe(1);

    // The store works on the recovered database.
    await expect(getItem('s', 'a')).resolves.toBe('x');
  });

  it('rejects when the recovery probe also fails and allows a later retry', async () => {
    failNextProbe = true;
    failEveryProbe = true;
    await expect(setItem('s', 'a', 'x')).rejects.toThrow();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // Both the first handle and the recovery-opened handle were closed.
    expect(closeCallCount).toBe(2);

    // The memoized open was dropped, so the next caller opens fresh and succeeds.
    failEveryProbe = false;
    await expect(setItem('s', 'a', 'x')).resolves.toBeUndefined();
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(3);
  });
});

describe('PRAGMA failure recovery', () => {
  it('closes the opened handle when the PRAGMA key fails, then recovers', async () => {
    failNextPragma = true;
    await setItem('s', 'a', 'x');

    // The PRAGMA-failed handle was closed before the recovery delete, and the
    // recovery-opened one stays open.
    expect(closeCallCount).toBe(1);
    expect(SQLite.deleteDatabaseAsync).toHaveBeenCalledWith('kilo-persist.db');
    // A fresh key was generated and stored over the old one.
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(2);
    expect(store.get(PERSIST_DB_KEY)).toMatch(/^02[0-9a-f]{62}$/);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    // The store works on the recovered database.
    await expect(getItem('s', 'a')).resolves.toBe('x');
  });

  it('closes both handles when the PRAGMA key fails on recovery too, then allows a retry', async () => {
    failEveryPragma = true;
    await expect(setItem('s', 'a', 'x')).rejects.toThrow();

    // Both the initial handle and the recovery-opened handle were closed.
    expect(closeCallCount).toBe(2);
    expect(SQLite.deleteDatabaseAsync).toHaveBeenCalledWith('kilo-persist.db');

    // The memoized open was dropped, so the next caller opens fresh and succeeds.
    failEveryPragma = false;
    await expect(setItem('s', 'a', 'x')).resolves.toBeUndefined();
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(3);
  });
});

describe('database key validation', () => {
  it('isValidDbKey accepts exactly 64 lowercase hex characters', () => {
    expect(isValidDbKey('a'.repeat(64))).toBe(true);
    expect(isValidDbKey('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('isValidDbKey rejects anything else', () => {
    expect(isValidDbKey('A'.repeat(64))).toBe(false);
    expect(isValidDbKey('a'.repeat(63))).toBe(false);
    expect(isValidDbKey('a'.repeat(65))).toBe(false);
    expect(isValidDbKey('g'.repeat(64))).toBe(false);
    expect(isValidDbKey('')).toBe(false);
    expect(isValidDbKey('not-a-hex-key')).toBe(false);
  });

  it('never interpolates a tampered SecureStore key and recovers with a fresh key', async () => {
    store.set(PERSIST_DB_KEY, 'tampered-key-not-hex');
    await setItem('s', 'a', 'x');

    // The tampered key never reached PRAGMA interpolation.
    expect(execLog.some(sql => sql.includes("x'tampered-key-not-hex'"))).toBe(false);
    // Recovery deleted the database, generated a fresh key, and reopened.
    expect(SQLite.deleteDatabaseAsync).toHaveBeenCalledWith('kilo-persist.db');
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
    const stored = store.get(PERSIST_DB_KEY);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(execLog).toContain(`PRAGMA key = "x'${stored}'"`);
    // No handle was opened for the tampered key, so only the fresh one is open.
    expect(closeCallCount).toBe(0);

    // The store works on the recovered database.
    await expect(getItem('s', 'a')).resolves.toBe('x');
  });

  it('treats a non-lowercase hex key as tampered and recovers', async () => {
    store.set(PERSIST_DB_KEY, 'A'.repeat(64));
    await setItem('s', 'a', 'x');
    expect(execLog.some(sql => sql.includes('AAAAAAAA'))).toBe(false);
    expect(store.get(PERSIST_DB_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a wrong-length hex key as tampered and recovers', async () => {
    store.set(PERSIST_DB_KEY, 'a'.repeat(32));
    await setItem('s', 'a', 'x');
    expect(store.get(PERSIST_DB_KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(execLog.some(sql => sql.includes("x'a".repeat(32)))).toBe(false);
  });
});

describe('kv behavior', () => {
  it('stores and reads a value', async () => {
    await setItem('draft:u1', 'agent-composer:new', 'hello');
    await expect(getItem('draft:u1', 'agent-composer:new')).resolves.toBe('hello');
  });

  it('returns null for a missing key', async () => {
    await expect(getItem('draft:u1', 'missing')).resolves.toBeNull();
  });

  it('upserts in place: value, bytes, and updated_at update, row count stays one', async () => {
    await setItem('s', 'k', 'one');
    const before = await listEntries('s');
    await setItem('s', 'k', 'two');
    await expect(getItem('s', 'k')).resolves.toBe('two');
    const after = await listEntries('s');
    expect(after).toHaveLength(1);
    expect(after[0]?.bytes).toBe(utf8ByteLength('two'));
    expect(after[0]?.updatedAt).toBeGreaterThanOrEqual(before[0]?.updatedAt ?? 0);
  });

  it('keeps distinct keys within a scope and across scopes', async () => {
    await setItem('s', 'a', 'x');
    await setItem('s', 'b', 'y');
    await setItem('other', 'a', 'z');
    await expect(getItem('s', 'a')).resolves.toBe('x');
    await expect(getItem('s', 'b')).resolves.toBe('y');
    await expect(getItem('other', 'a')).resolves.toBe('z');
  });

  it('removes a single key', async () => {
    await setItem('s', 'a', 'x');
    await setItem('s', 'b', 'y');
    await removeItem('s', 'a');
    await expect(getItem('s', 'a')).resolves.toBeNull();
    await expect(getItem('s', 'b')).resolves.toBe('y');
  });

  it('removeItem on a missing key is a no-op', async () => {
    await expect(removeItem('s', 'missing')).resolves.toBeUndefined();
  });

  it('clearScope removes only the exact scope', async () => {
    await setItem('cache:u1:1', 'a', 'x');
    await setItem('cache:u2:1', 'a', 'y');
    await clearScope('cache:u1:1');
    await expect(getItem('cache:u1:1', 'a')).resolves.toBeNull();
    await expect(getItem('cache:u2:1', 'a')).resolves.toBe('y');
  });

  it('clearScopePrefix removes every scope starting with the prefix (LIKE semantics)', async () => {
    await setItem('cache:u1:1', 'a', 'x');
    await setItem('cache:u12:1', 'a', 'y');
    await setItem('draft:u1', 'b', 'z');
    await clearScopePrefix('cache:u1');
    await expect(getItem('cache:u1:1', 'a')).resolves.toBeNull();
    await expect(getItem('cache:u12:1', 'a')).resolves.toBeNull();
    await expect(getItem('draft:u1', 'b')).resolves.toBe('z');
  });

  it('clearScopePrefix does not remove scopes that only contain the prefix later', async () => {
    await setItem('cache:u1:1', 'a', 'x');
    await setItem('mycache:u1', 'b', 'z');
    await clearScopePrefix('cache:u1');
    await expect(getItem('cache:u1:1', 'a')).resolves.toBeNull();
    await expect(getItem('mycache:u1', 'b')).resolves.toBe('z');
  });

  it('clearScopePrefix with a full scope string matches only that scope', async () => {
    await setItem('cache:u1:1', 'a', 'x');
    await setItem('cache:u12:1', 'a', 'y');
    await clearScopePrefix('cache:u1:1');
    await expect(getItem('cache:u1:1', 'a')).resolves.toBeNull();
    await expect(getItem('cache:u12:1', 'a')).resolves.toBe('y');
  });

  it('scopeBytes sums stored UTF-8 byte lengths and is 0 when empty', async () => {
    await expect(scopeBytes('s')).resolves.toBe(0);
    await setItem('s', 'a', 'hi');
    await setItem('s', 'b', 'héllo');
    await setItem('s', 'c', '🎉');
    await expect(scopeBytes('s')).resolves.toBe(2 + 6 + 4);
    await expect(scopeBytes('other')).resolves.toBe(0);
  });

  it('listEntries returns k, bytes, and updatedAt without values', async () => {
    await setItem('s', 'oldest', 'a');
    await setItem('s', 'newest', 'b');
    const entries = await listEntries('s');
    expect(entries).toHaveLength(2);
    expect(Object.keys(entries[0] ?? {})).toEqual(['k', 'bytes', 'updatedAt']);
    expect(entries[0]?.bytes).toBe(1);
    expect(typeof entries[0]?.updatedAt).toBe('number');
  });

  it('listEntries orders entries oldest-first by updated_at', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      await setItem('s', 'newer', 'b');
      vi.setSystemTime(2000);
      await setItem('s', 'older', 'a');
      const entries = await listEntries('s');
      expect(entries.map(entry => entry.k)).toEqual(['newer', 'older']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('listEntries returns an empty array for an absent scope', async () => {
    await expect(listEntries('nope')).resolves.toEqual([]);
  });

  it('utf8ByteLength counts UTF-8 bytes', () => {
    expect(utf8ByteLength('hi')).toBe(2);
    expect(utf8ByteLength('héllo')).toBe(6);
    expect(utf8ByteLength('🎉')).toBe(4);
  });
});
