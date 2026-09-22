import { describe, expect, it } from 'vitest';
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_ENTRIES,
  addSessionReference,
  emptySessionReferenceState,
  hasForeignReference,
  markReferencesReconciled,
  removeSessionReference,
  removeWorktreeReferences,
  serializedReferenceBytes,
  worktreeIdFromDirectory,
  type SessionReference,
  type SessionReferenceTarget,
} from './session-references';
import {
  SESSION_REFERENCES_KEY,
  loadSessionReferences,
  saveSessionReferences,
  sessionReferenceStateSchema,
} from './durable-state';

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const otherWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';
const directory = `/workspace/paths/user/project/${worktreeId}`;
const otherDirectory = `/workspace/paths/user/project/${otherWorktreeId}`;

function memoryStorage() {
  const records = new Map<string, unknown>();
  return {
    records,
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      records.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      records.set(key, value);
    },
    delete: async (keys: string[]) => {
      let deleted = 0;
      for (const key of keys) if (records.delete(key)) deleted++;
      return deleted;
    },
  };
}

function target(overrides: Partial<SessionReferenceTarget> = {}): SessionReferenceTarget {
  return {
    worktreeId,
    directory,
    sessionIds: new Set(['ses_root', 'ses_child']),
    releasedWorktreeIds: new Set(),
    ...overrides,
  };
}

const ownReference: SessionReference = {
  sessionId: 'workspace_root',
  kiloSessionId: 'ses_root',
  directory,
  worktreeId,
};

function entriesWithByteSize(bytes: number): SessionReference[] {
  const entries: SessionReference[] = [];
  const entry = (index: number, length: number): SessionReference => ({
    sessionId: `ses_${index}`,
    kiloSessionId: `kilo_${index}`,
    directory: 'd'.repeat(length),
  });
  while (
    entries.length < MAX_REFERENCE_ENTRIES &&
    serializedReferenceBytes([...entries, entry(entries.length, 150)]) <= bytes
  ) {
    entries.push(entry(entries.length, 150));
  }
  const last = entries.at(-1);
  if (!last) throw new Error('Byte-size fixture needs at least one entry');
  last.directory = 'd'.repeat(last.directory.length + bytes - serializedReferenceBytes(entries));
  if (serializedReferenceBytes(entries) !== bytes) throw new Error('Byte-size fixture mismatch');
  return entries;
}

describe('session references', () => {
  it('blocks while a detached session still references the sandbox', () => {
    const tombstone = {
      sessionId: 'workspace_detached',
      kiloSessionId: 'ses_orphan',
      directory: otherDirectory,
    };
    expect(hasForeignReference(emptySessionReferenceState(), [tombstone], target())).toBe(true);
    expect(
      hasForeignReference(
        emptySessionReferenceState(),
        [{ ...tombstone, directory, worktreeId: otherWorktreeId }],
        target()
      )
    ).toBe(true);
    expect(
      hasForeignReference(emptySessionReferenceState(), [{ ...tombstone, directory }], target())
    ).toBe(true);
  });

  it('does not block on the target worktree\u2019s own sessions', () => {
    const state = emptySessionReferenceState();
    addSessionReference(state, ownReference);
    expect(hasForeignReference(state, state.entries, target())).toBe(false);
    expect(hasForeignReference(state, [], target())).toBe(false);
  });

  it('ignores references from released worktrees', () => {
    const released = new Set([otherWorktreeId]);
    expect(
      hasForeignReference(
        emptySessionReferenceState(),
        [{ ...ownReference, worktreeId: otherWorktreeId, directory: otherDirectory }],
        target({ releasedWorktreeIds: released })
      )
    ).toBe(false);
    expect(
      hasForeignReference(
        emptySessionReferenceState(),
        [{ ...ownReference, worktreeId: undefined, directory: otherDirectory }],
        target({ releasedWorktreeIds: released })
      )
    ).toBe(false);
    expect(worktreeIdFromDirectory(otherDirectory)).toBe(otherWorktreeId);
  });

  it('keeps detached evidence when the session re-attaches', () => {
    const state = emptySessionReferenceState();
    addSessionReference(state, { ...ownReference, worktreeId: undefined });
    expect(state.entries).toHaveLength(1);

    const reattached = addSessionReference(state, { ...ownReference, directory: otherDirectory });
    expect(reattached.changed).toBe(false);
    expect(state.entries).toEqual([{ ...ownReference, worktreeId: undefined }]);
    expect(hasForeignReference(state, state.entries, target())).toBe(false);
  });

  it('fails closed once the reference set overflows', () => {
    const state = emptySessionReferenceState();
    for (let index = 0; index <= MAX_REFERENCE_ENTRIES; index++) {
      addSessionReference(state, {
        sessionId: `s${index}`,
        kiloSessionId: `k${index}`,
        directory: 'd',
      });
    }
    expect(state.overflowed).toBe(true);
    expect(state.entries.length).toBe(MAX_REFERENCE_ENTRIES);
    expect(hasForeignReference(state, [...state.entries], target())).toBe(true);
    expect(hasForeignReference(state, [], target())).toBe(true);
  });

  it('fails closed before the serialized state exceeds its byte budget', () => {
    const state = emptySessionReferenceState();
    for (let index = 0; !state.overflowed; index++) {
      addSessionReference(state, {
        sessionId: `ses_${index}`,
        kiloSessionId: `kilo_${index}`,
        directory: 'd'.repeat(256),
        worktreeId,
      });
      if (index > MAX_REFERENCE_ENTRIES * 2) throw new Error('Index never overflowed');
    }
    expect(state.overflowed).toBe(true);
    expect(state.entries.length).toBeLessThan(MAX_REFERENCE_ENTRIES);
    expect(serializedReferenceBytes(state.entries)).toBeLessThanOrEqual(MAX_REFERENCE_BYTES);

    const atLimit = {
      reconciled: false,
      overflowed: false,
      entries: entriesWithByteSize(MAX_REFERENCE_BYTES),
    };
    expect(sessionReferenceStateSchema.parse(atLimit)).toEqual(atLimit);
    const over = structuredClone(atLimit);
    over.entries[0].directory += 'd';
    expect(serializedReferenceBytes(over.entries)).toBe(MAX_REFERENCE_BYTES + 1);
    expect(() => sessionReferenceStateSchema.parse(over)).toThrow();
  });

  it('counts multibyte and escaped strings by UTF-8 bytes', async () => {
    const entry: SessionReference = {
      sessionId: 'ses_"\\\né',
      kiloSessionId: 'kilo_é',
      directory: '/résumé/é\\"\n',
    };
    const serialized = JSON.stringify([entry]);
    expect(serializedReferenceBytes([entry])).toBe(new TextEncoder().encode(serialized).byteLength);
    expect(serializedReferenceBytes([entry])).toBeGreaterThan(serialized.length);

    const state = emptySessionReferenceState();
    addSessionReference(state, entry);
    const storage = memoryStorage();
    await saveSessionReferences(storage, state);
    expect(await loadSessionReferences(storage)).toEqual(state);

    const nearLimit = emptySessionReferenceState();
    const filler = (index: number): SessionReference => ({
      sessionId: `s${index}`,
      kiloSessionId: `k${index}`,
      directory: 'é'.repeat(200),
    });
    while (
      serializedReferenceBytes([...nearLimit.entries, filler(nearLimit.entries.length)]) <
      MAX_REFERENCE_BYTES
    ) {
      nearLimit.entries.push(filler(nearLimit.entries.length));
    }
    const beforeCount = nearLimit.entries.length;
    expect(beforeCount).toBeLessThan(MAX_REFERENCE_ENTRIES);
    expect(serializedReferenceBytes(nearLimit.entries)).toBeLessThan(MAX_REFERENCE_BYTES);

    const crossing: SessionReference = {
      sessionId: 'ses_cross',
      kiloSessionId: 'kilo_cross',
      directory: 'é'.repeat(300),
    };
    expect(serializedReferenceBytes([...nearLimit.entries, crossing])).toBeGreaterThan(
      MAX_REFERENCE_BYTES
    );
    expect(JSON.stringify([...nearLimit.entries, crossing]).length).toBeLessThan(
      MAX_REFERENCE_BYTES
    );

    addSessionReference(nearLimit, crossing);
    expect(nearLimit.overflowed).toBe(true);
    expect(nearLimit.entries.length).toBe(beforeCount);
  });

  it('applies one predicate to index entries and current routes', () => {
    const state = emptySessionReferenceState();
    addSessionReference(state, ownReference);
    const route = {
      sessionId: ownReference.sessionId,
      kiloSessionId: ownReference.kiloSessionId,
      directory: ownReference.directory,
      worktreeId: otherWorktreeId,
    };
    expect(hasForeignReference(state, [...state.entries], target())).toBe(false);
    expect(
      hasForeignReference(emptySessionReferenceState(), [{ ...route, worktreeId }], target())
    ).toBe(false);
    expect(hasForeignReference(emptySessionReferenceState(), [route], target())).toBe(true);
  });

  it('removeWorktreeReferences clears entries with and without a stored worktree id', () => {
    const state = emptySessionReferenceState();
    addSessionReference(state, ownReference);
    addSessionReference(state, {
      sessionId: 'workspace_directory_only',
      kiloSessionId: 'ses_child',
      directory,
    });
    addSessionReference(state, {
      sessionId: 'workspace_other',
      kiloSessionId: 'ses_other',
      directory: otherDirectory,
      worktreeId: otherWorktreeId,
    });
    markReferencesReconciled(state);

    expect(removeWorktreeReferences(state, worktreeId).changed).toBe(true);
    expect(state.entries).toEqual([
      {
        sessionId: 'workspace_other',
        kiloSessionId: 'ses_other',
        directory: otherDirectory,
        worktreeId: otherWorktreeId,
      },
    ]);
    expect(state.reconciled).toBe(true);
    expect(removeWorktreeReferences(state, worktreeId).changed).toBe(false);
    expect(removeSessionReference(state, 'workspace_other').changed).toBe(true);
    expect(state.entries).toEqual([]);
    expect(removeSessionReference(state, 'workspace_other').changed).toBe(false);
  });

  it('persists and restores an absent and a reconciled index without seeding', async () => {
    const storage = memoryStorage();
    expect(storage.records.has(SESSION_REFERENCES_KEY)).toBe(false);
    expect(await loadSessionReferences(storage)).toEqual(emptySessionReferenceState());
    const state = emptySessionReferenceState();
    markReferencesReconciled(state);
    await saveSessionReferences(storage, state);
    expect(await loadSessionReferences(storage)).toEqual(state);
  });
});
