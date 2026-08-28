/* eslint-disable max-lines -- cohesive unit suite for the encrypted-kv open/recovery contract, key validation, and KV behavior */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake native lifecycle methods and vi.fn factories settle without await because node:sqlite calls are synchronous */
// eslint-disable-next-line import/no-nodejs-modules -- node:sqlite is the only way to run real SQL semantics in a node test; the expo-sqlite native module cannot load here
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import * as Sentry from '@sentry/react-native';
import * as Crypto from 'expo-crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native modules cannot run in a node test, so they are mocked. Drizzle's
// expo driver drives the *synchronous* expo-sqlite API (`openDatabaseSync`,
// `prepareSync`, `executeSync`), so the mock exposes that shape and backs it
// with node:sqlite: the SQL Drizzle generates (LIKE, upsert, composite primary
// key, the generated migration) runs on the real engine, while open, probe, and
// recovery behavior is driven by the test seams below.

const store = new Map<string, string>();
// Every SQL statement Drizzle prepares, in order. `PRAGMA key`, the probes, and
// the migration all pass through `prepareSync`, so this is the whole statement
// stream for one open.
const sqlLog: string[] = [];
let randomCallCount = 0;
let failNextProbe = false;
let failEveryProbe = false;
let failNextPragma = false;
let failEveryPragma = false;
// Simulates a native build without SQLCipher: `PRAGMA cipher_version` returns
// no row, exactly as plain SQLite does for an unrecognized pragma.
let hasSQLCipher = true;
// Number of statements that had been prepared when `cipher_version` was
// probed; -1 when it was never probed. Proves the probe precedes `PRAGMA key`.
let cipherProbedAtSqlCount = -1;
let closeCallCount = 0;

type FakeExecuteResult = {
  changes: number | bigint;
  lastInsertRowId: number | bigint;
  getAllSync: () => Record<string, unknown>[];
  getFirstSync: () => Record<string, unknown> | null;
};

type FakeStatement = {
  executeSync: (params?: SQLInputValue[]) => FakeExecuteResult;
  executeForRawResultSync: (params?: SQLInputValue[]) => { getAllSync: () => unknown[][] };
};

type FakeDatabase = {
  // Connection setup runs on the raw handle, ahead of Drizzle: `getFirstSync`
  // proves SQLCipher and `execSync` sets the key.
  getFirstSync: (source: string) => Record<string, unknown> | null;
  execSync: (source: string) => void;
  prepareSync: (source: string) => FakeStatement;
  closeAsync: () => Promise<void>;
};

/** A statement whose rows the fake answers itself, computed at execute time. */
function fakeRows(rows: () => Record<string, unknown>[]): FakeStatement {
  return {
    executeSync: () => {
      const values = rows();
      return {
        changes: 0,
        lastInsertRowId: 0,
        getAllSync: () => values,
        getFirstSync: () => values[0] ?? null,
      };
    },
    executeForRawResultSync: () => ({ getAllSync: () => rows().map(row => Object.values(row)) }),
  };
}

/** A statement executed by node:sqlite, in expo-sqlite's result shape. */
function nativeStatement(statement: StatementSync): FakeStatement {
  const returnsRows = statement.columns().length > 0;
  return {
    executeSync: (params = []) => {
      if (!returnsRows) {
        const { changes, lastInsertRowid } = statement.run(...params);
        return {
          changes,
          lastInsertRowId: lastInsertRowid,
          getAllSync: () => [],
          getFirstSync: () => null,
        };
      }
      const rows = statement.all(...params);
      return {
        changes: 0,
        lastInsertRowId: 0,
        getAllSync: () => rows,
        getFirstSync: () => rows[0] ?? null,
      };
    },
    executeForRawResultSync: (params = []) => ({
      getAllSync: () => statement.all(...params).map(row => Object.values(row)),
    }),
  };
}

function createFakeStatement(native: DatabaseSync, source: string): FakeStatement {
  // Probe failure seam: a wrong key or corrupt file throws at the probe.
  if (source.includes('sqlite_master')) {
    return fakeRows(() => {
      if (failNextProbe) {
        failNextProbe = false;
        throw new Error('file is not a database');
      }
      if (failEveryProbe) {
        throw new Error('file is not a database');
      }
      return [{ 'count(*)': 0 }];
    });
  }
  return nativeStatement(native.prepare(source));
}

function createFakeDatabase(): FakeDatabase {
  const native = new DatabaseSync(':memory:');
  return {
    // SQLCipher presence seam. node:sqlite has no `cipher_version` pragma, so
    // the fake answers it directly.
    getFirstSync: source => {
      sqlLog.push(source);
      if (source.startsWith('PRAGMA cipher_version')) {
        cipherProbedAtSqlCount = sqlLog.length - 1;
        return hasSQLCipher ? { cipher_version: '4.5.5 community' } : null;
      }
      return native.prepare(source).get() ?? null;
    },
    // PRAGMA failure seam: the key call can fail after the handle opened.
    execSync: source => {
      sqlLog.push(source);
      if (source.startsWith('PRAGMA key') && (failEveryPragma || failNextPragma)) {
        failNextPragma = false;
        throw new Error('PRAGMA key failed');
      }
      native.exec(source);
    },
    prepareSync: source => {
      sqlLog.push(source);
      return createFakeStatement(native, source);
    },
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
  openDatabaseSync: vi.fn(() => createFakeDatabase()),
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
  setItem,
  validateItemKey,
  validateScope,
} from './encrypted-kv';
/* eslint-enable import/first */

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  sqlLog.length = 0;
  randomCallCount = 0;
  failNextProbe = false;
  failEveryProbe = false;
  failNextPragma = false;
  failEveryPragma = false;
  hasSQLCipher = true;
  cipherProbedAtSqlCount = -1;
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
    expect(SQLite.openDatabaseSync).not.toHaveBeenCalled();
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
    const keyIndex = sqlLog.findIndex(source => source.startsWith('PRAGMA key'));
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    // The probe was the very first statement, so it precedes the key.
    expect(cipherProbedAtSqlCount).toBe(0);
    expect(keyIndex).toBeGreaterThan(cipherProbedAtSqlCount);
    // SQLCipher needs the key before anything reads the file, so the key runs
    // before every Drizzle statement: the probe, the migration, and the query.
    const firstDrizzleIndex = sqlLog.findIndex(
      source => source.includes('sqlite_master') || source.includes('__drizzle_migrations')
    );
    expect(firstDrizzleIndex).toBeGreaterThan(keyIndex);
  });

  it('refuses to open a plaintext database when the build has no SQLCipher', async () => {
    hasSQLCipher = false;
    await expect(setItem('s', 'a', 'x')).rejects.toThrow(MissingSQLCipherError);
    // No key is ever set on an unencrypted handle.
    expect(sqlLog.some(source => source.startsWith('PRAGMA key'))).toBe(false);
  });

  it('never deletes the database when the build has no SQLCipher', async () => {
    hasSQLCipher = false;
    await expect(setItem('s', 'a', 'x')).rejects.toThrow(MissingSQLCipherError);
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalled();
  });

  it('reports a missing SQLCipher build exactly once, however many callers arrive', async () => {
    hasSQLCipher = false;
    await expect(setItem('s', 'a', 'x')).rejects.toThrow(MissingSQLCipherError);
    await expect(getItem('s', 'a')).rejects.toThrow(MissingSQLCipherError);
    await expect(clearScope('s')).rejects.toThrow(MissingSQLCipherError);
    expect(SQLite.openDatabaseSync).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(MissingSQLCipherError), {
      level: 'error',
      tags: { 'error.subsystem': 'encrypted-kv', 'error.operation': 'open' },
      fingerprint: ['encrypted-kv-missing-sqlcipher'],
    });
  });
});

describe('single-flight open contract', () => {
  it('opens the database once for concurrent callers', async () => {
    await Promise.all([setItem('s', 'a', 'x'), setItem('s', 'b', 'y')]);
    expect(SQLite.openDatabaseSync).toHaveBeenCalledTimes(1);
    await expect(getItem('s', 'a')).resolves.toBe('x');
    await expect(getItem('s', 'b')).resolves.toBe('y');
  });

  it('reuses the opened database for later calls', async () => {
    await setItem('s', 'a', 'x');
    await setItem('s', 'b', 'y');
    await getItem('s', 'a');
    expect(SQLite.openDatabaseSync).toHaveBeenCalledTimes(1);
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
    expect(sqlLog).toContain(`PRAGMA key = "x'${key}'"`);
  });

  it('creates the DEC-01 schema on open by running the generated migration', async () => {
    await setItem('s', 'a', 'x');
    const createSql = sqlLog.find(sql => sql.includes('CREATE TABLE `kv`'));
    expect(createSql).toContain('PRIMARY KEY(`scope`, `k`)');
    expect(createSql).toContain('`updated_at` integer NOT NULL');
    expect(createSql).toContain('`scope` text NOT NULL');
    expect(createSql).toContain('`k` text NOT NULL');
    expect(createSql).toContain('`v` text NOT NULL');
  });

  it('records the applied migration so a reopened database does not re-run it', async () => {
    await setItem('s', 'a', 'x');
    // Drizzle owns the bookkeeping: it creates its ledger, reads the last
    // applied entry, and records the migration it just ran.
    expect(
      sqlLog.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS "__drizzle_migrations"'))
    ).toBe(true);
    expect(sqlLog.some(sql => sql.includes('INSERT INTO "__drizzle_migrations"'))).toBe(true);
  });
});

describe('nondestructive open recovery', () => {
  it.each(['SQLITE_IOERR', 'disk I/O error', 'database is locked', 'unable to open database file'])(
    'classifies temporary native failure %s as retryable',
    async message => {
      const { encryptedStoreRecovery } = await import('./encrypted-kv');
      expect(encryptedStoreRecovery(new Error(message))).toEqual({
        status: 'retryable',
        reason: 'io',
        guidance: 'retry',
      });
    }
  );
  it.each([
    {
      seam: 'probe',
      fail: () => {
        failNextProbe = true;
      },
      reason: 'corrupt-database',
    },
    {
      seam: 'PRAGMA key',
      fail: () => {
        failNextPragma = true;
      },
      reason: 'unknown',
    },
  ])('protects a failing $seam until explicit Retry', async ({ fail, reason }) => {
    store.set(PERSIST_DB_KEY, 'a'.repeat(64));
    fail();
    await expect(setItem('s', 'a', 'x')).rejects.toThrow(reason);
    await expect(getItem('s', 'a')).rejects.toThrow(reason);
    expect(store.get(PERSIST_DB_KEY)).toBe('a'.repeat(64));
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalled();
    expect(Crypto.getRandomBytesAsync).not.toHaveBeenCalled();
    expect(SQLite.openDatabaseSync).toHaveBeenCalledTimes(1);
    const { retryEncryptedKvOpen } = await import('./encrypted-kv');
    await Promise.all([retryEncryptedKvOpen(), retryEncryptedKvOpen(), retryEncryptedKvOpen()]);
    await setItem('s', 'a', 'x');
    await expect(getItem('s', 'a')).resolves.toBe('x');
    expect(SQLite.openDatabaseSync).toHaveBeenCalledTimes(2);
    expect(closeCallCount).toBe(1);
    expect(store.get(PERSIST_DB_KEY)).toBe('a'.repeat(64));
  });

  it('does not replace a pending memo when concurrent Retry arrives', async () => {
    const secureStore = await import('expo-secure-store');
    const gate = Promise.withResolvers<string | null>();
    vi.mocked(secureStore.getItemAsync).mockReturnValueOnce(gate.promise);
    const { retryEncryptedKvOpen } = await import('./encrypted-kv');
    const first = getItem('s', 'k');
    const retry = retryEncryptedKvOpen();
    gate.resolve('b'.repeat(64));
    await Promise.all([first, retry]);
    await retryEncryptedKvOpen();
    await setItem('s', 'k', 'retained');
    await expect(getItem('s', 'k')).resolves.toBe('retained');
    expect(SQLite.openDatabaseSync).toHaveBeenCalledTimes(1);
  });

  it('retries temporary SecureStore failures without regenerating the stored key', async () => {
    const secureStore = await import('expo-secure-store');
    const { retryEncryptedKvOpen, encryptedStoreRecovery } = await import('./encrypted-kv');
    store.set(PERSIST_DB_KEY, 'c'.repeat(64));
    vi.mocked(secureStore.getItemAsync).mockRejectedValueOnce(new Error('temporarily locked'));
    try {
      await getItem('s', 'k');
      throw new Error('The read must reject');
    } catch (error) {
      expect(encryptedStoreRecovery(error)).toEqual({
        status: 'retryable',
        reason: 'secure-store',
        guidance: 'retry',
      });
    }
    await expect(getItem('s', 'k')).rejects.toThrow('secure-store');
    expect(SQLite.openDatabaseSync).not.toHaveBeenCalled();
    await Promise.all([retryEncryptedKvOpen(), retryEncryptedKvOpen()]);
    await setItem('s', 'k', 'restored');
    await expect(getItem('s', 'k')).resolves.toBe('restored');
    expect(store.get(PERSIST_DB_KEY)).toBe('c'.repeat(64));
    expect(Crypto.getRandomBytesAsync).not.toHaveBeenCalled();
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalled();
  });

  it('retains the first generated key when its SecureStore write temporarily fails', async () => {
    const secureStore = await import('expo-secure-store');
    const { retryEncryptedKvOpen } = await import('./encrypted-kv');
    vi.mocked(secureStore.setItemAsync).mockRejectedValueOnce(new Error('temporary write failure'));
    await expect(getItem('s', 'k')).rejects.toThrow('secure-store');
    await retryEncryptedKvOpen();
    await setItem('s', 'k', 'value');
    await expect(getItem('s', 'k')).resolves.toBe('value');
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
    expect(store.get(PERSIST_DB_KEY)).toMatch(/^01[0-9a-f]{62}$/);
  });

  it.each(['corrupt', 'missing-sqlcipher'])(
    'keeps terminal %s failures protected across explicit Retry',
    async kind => {
      store.set(PERSIST_DB_KEY, 'd'.repeat(64));
      failEveryProbe = kind === 'corrupt';
      hasSQLCipher = kind !== 'missing-sqlcipher';
      const { retryEncryptedKvOpen } = await import('./encrypted-kv');
      await expect(getItem('s', 'k')).rejects.toThrow();
      await expect(retryEncryptedKvOpen()).rejects.toThrow();
      await expect(getItem('s', 'k')).rejects.toThrow();
      expect(store.get(PERSIST_DB_KEY)).toBe('d'.repeat(64));
      expect(SQLite.openDatabaseSync).toHaveBeenCalledTimes(2);
      expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalled();
      expect(Crypto.getRandomBytesAsync).not.toHaveBeenCalled();
    }
  );

  it('fences a deferred SQL write and cleanup after the owner changes during open', async () => {
    const secureStore = await import('expo-secure-store');
    const gate = Promise.withResolvers<string | null>();
    vi.mocked(secureStore.getItemAsync).mockReturnValueOnce(gate.promise);
    let current = true;
    const write = setItem('draft:a', 'k', 'stale', () => current);
    const cleanup = clearScope('draft:a', () => current);
    current = false;
    gate.resolve('e'.repeat(64));
    await Promise.all([write, cleanup]);
    await expect(getItem('draft:a', 'k')).resolves.toBeNull();
    expect(
      sqlLog.some(
        source => source.startsWith('insert into "kv"') || source.startsWith('delete from "kv"')
      )
    ).toBe(false);
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

  it.each([
    { kind: 'empty', tamperedKey: '', forbidden: 'PRAGMA key' },
    { kind: 'non-hex', tamperedKey: 'tampered-key-not-hex', forbidden: "x'tampered-key-not-hex'" },
    { kind: 'non-lowercase hex', tamperedKey: 'A'.repeat(64), forbidden: 'AAAAAAAA' },
    { kind: 'wrong-length hex', tamperedKey: 'a'.repeat(32), forbidden: "x'a".repeat(32) },
  ])('never interpolates or replaces a $kind key', async ({ tamperedKey, forbidden }) => {
    store.set(PERSIST_DB_KEY, tamperedKey);
    await expect(setItem('s', 'a', 'x')).rejects.toThrow('malformed-key');
    const { retryEncryptedKvOpen } = await import('./encrypted-kv');
    await expect(retryEncryptedKvOpen()).rejects.toThrow('malformed-key');
    expect(sqlLog.some(sql => sql.includes(forbidden))).toBe(false);
    expect(SQLite.deleteDatabaseAsync).not.toHaveBeenCalled();
    expect(Crypto.getRandomBytesAsync).not.toHaveBeenCalled();
    expect(store.get(PERSIST_DB_KEY)).toBe(tamperedKey);
    expect(closeCallCount).toBe(0);
  });
});

describe('kv behavior', () => {
  it('cleans only literal user prefixes and numeric cache versions', async () => {
    await setItem('cache:a_%:1', 'k', 'a');
    await setItem('cache:a_%:2', 'k', 'a2');
    await setItem('cache:aXX:1', 'k', 'wildcard collision');
    await setItem('cache:a_%:nested:1', 'k', 'nested user');
    await clearScopePrefix('cache:a_%:', undefined, true);
    await expect(getItem('cache:a_%:1', 'k')).resolves.toBeNull();
    await expect(getItem('cache:a_%:2', 'k')).resolves.toBeNull();
    await expect(getItem('cache:aXX:1', 'k')).resolves.toBe('wildcard collision');
    await expect(getItem('cache:a_%:nested:1', 'k')).resolves.toBe('nested user');
  });
  it('stores and reads a value', async () => {
    await setItem('draft:u1', 'agent-composer:new', 'hello');
    await expect(getItem('draft:u1', 'agent-composer:new')).resolves.toBe('hello');
  });

  it('returns null for a missing key', async () => {
    await expect(getItem('draft:u1', 'missing')).resolves.toBeNull();
  });

  it('upserts in place: value and updated_at update, row count stays one', async () => {
    await setItem('s', 'k', 'one');
    const before = await listEntries('s');
    await setItem('s', 'k', 'two');
    await expect(getItem('s', 'k')).resolves.toBe('two');
    const after = await listEntries('s');
    expect(after).toHaveLength(1);
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

  it('clearScopePrefix on a user prefix clears every schema version, and nothing else', async () => {
    // The sign-out prefix `cache:<userId>:`, on the real SQL engine: it must
    // cover both schema versions of that user and leave the other account's
    // cache and the user's drafts alone.
    await setItem('cache:u1:1', 'read-cache', 'x');
    await setItem('cache:u1:2', 'read-cache', 'x2');
    await setItem('cache:u12:1', 'read-cache', 'y');
    await setItem('draft:u1', 'agent-composer:new', 'z');

    await clearScopePrefix('cache:u1:');

    await expect(getItem('cache:u1:1', 'read-cache')).resolves.toBeNull();
    await expect(getItem('cache:u1:2', 'read-cache')).resolves.toBeNull();
    await expect(getItem('cache:u12:1', 'read-cache')).resolves.toBe('y');
    await expect(getItem('draft:u1', 'agent-composer:new')).resolves.toBe('z');
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

  it('listEntries returns k and updatedAt without values', async () => {
    await setItem('s', 'oldest', 'a');
    await setItem('s', 'newest', 'b');
    const entries = await listEntries('s');
    expect(entries).toHaveLength(2);
    expect(Object.keys(entries[0] ?? {})).toEqual(['k', 'updatedAt']);
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
});
