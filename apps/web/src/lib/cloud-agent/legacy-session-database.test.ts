import { describe, expect, it, jest, afterEach } from '@jest/globals';
import type * as LegacySessionDatabase from './legacy-session-database';

type PurgeModule = typeof LegacySessionDatabase;

const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

function loadModule(): PurgeModule {
  let loaded: PurgeModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<PurgeModule>('./legacy-session-database');
  });
  if (!loaded) throw new Error('module did not load');
  return loaded;
}

function deleteDatabaseStub(
  implementation: () => IDBOpenDBRequest = () => ({}) as IDBOpenDBRequest
) {
  const calls: string[] = [];
  const deleteDatabase = (name: string) => {
    calls.push(name);
    return implementation();
  };
  return { deleteDatabase, calls };
}

function setIndexedDb(value: unknown) {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value });
}

describe('purgeLegacySessionDatabase', () => {
  afterEach(() => {
    if (indexedDbDescriptor) {
      Object.defineProperty(globalThis, 'indexedDB', indexedDbDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });

  it('deletes the retired cloud agent session database by its exact name', () => {
    const { deleteDatabase, calls } = deleteDatabaseStub();
    setIndexedDb({ deleteDatabase });

    loadModule().purgeLegacySessionDatabase();

    expect(calls).toEqual(['kilocode-cloud-sessions']);
  });

  it('keeps the app working when the deletion throws', () => {
    const { deleteDatabase, calls } = deleteDatabaseStub(() => {
      throw new Error('refused');
    });
    setIndexedDb({ deleteDatabase });

    expect(() => loadModule().purgeLegacySessionDatabase()).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('asks once per page load', () => {
    const { deleteDatabase, calls } = deleteDatabaseStub();
    setIndexedDb({ deleteDatabase });

    const purge = loadModule().purgeLegacySessionDatabase;
    purge();
    purge();

    expect(calls).toHaveLength(1);
  });

  it('does nothing when the environment has no IndexedDB', () => {
    setIndexedDb(undefined);

    expect(() => loadModule().purgeLegacySessionDatabase()).not.toThrow();
  });
});
