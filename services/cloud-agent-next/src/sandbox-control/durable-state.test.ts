import { describe, expect, it } from 'vitest';
import {
  eraseSandboxRecord,
  loadAllocation,
  initialRuntimeMetadata,
  loadRuntimeMetadata,
  saveRuntimeMetadata,
  loadRouteTable,
  loadSessionCredentialGrants,
  loadSessionReferences,
  loadTransitionLog,
  saveRouteTable,
  saveSessionCredentialGrants,
  saveSessionReferences,
  saveTransitionLog,
  storeAllocation,
  SESSION_REFERENCES_KEY,
} from './durable-state.js';
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_ENTRIES,
  addSessionReference,
  emptySessionReferenceState,
  markReferencesReconciled,
  serializedReferenceBytes,
} from './session-references.js';
import { createControlPlaneCredential } from './managed-credential.js';
import { CONTROL_ALARM_ANCHORS_KEY, LEGACY_CONTROL_DEADLINES_KEY } from './control-alarm.js';
import { allocationFixture } from '../sandbox-state/model/allocation-fixtures.js';
import { WORKTREE_CREDENTIAL_CONTAINMENT } from '../sandbox-state/model/allocation.js';
import type { SessionCredentialGrant } from './session-credentials.js';
import { attachRoute, emptyRouteTable, resolveSessionEventRoute } from './session-routes.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SECOND_SESSION_ID = 'workspace_22222222-2222-4222-8222-222222222222';
const LEGACY_SESSION_ID = 'workspace_33333333-3333-4333-8333-333333333333';
const ROOT_ID = 'ses_abcdefghijklmnopqrstuvwxyz';
const SECOND_ROOT_ID = 'ses_zyxwvutsrqponmlkjihgfedcba';
const LEGACY_ROOT_ID = 'ses_01234567890123456789012345';

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      values.set(key, structuredClone(value));
    },
    async delete(keys: string[]): Promise<number> {
      let deleted = 0;
      for (const key of keys) {
        if (values.delete(key)) deleted++;
      }
      return deleted;
    },
  };
}

function credentialGrant(): SessionCredentialGrant {
  return {
    version: 1,
    scopeId: 'worktree_1',
    sandboxId: 'ses-a1b2c3',
    directory: '/workspace/a',
    userId: 'owner_1',
    provider: 'vercel',
    members: [
      { sessionId: SESSION_ID, kiloSessionId: ROOT_ID },
      { sessionId: SECOND_SESSION_ID, kiloSessionId: SECOND_ROOT_ID },
    ],
    kilo: {
      alias: createControlPlaneCredential('ses-a1b2c3', 'kilo'),
      token: 'test-kilo-token',
      targets: {
        backendBaseUrl: 'https://backend.example.com',
        providerBaseUrl: 'https://provider.example.com/api/openrouter',
        sessionIngestBaseUrl: 'https://ingest.example.com',
      },
      capabilities: {},
    },
    preparedAt: 1000,
    expiresAt: 2000,
  };
}

describe('sandbox control durable state', () => {
  it.each([
    ['usr-abcd', 'shared'],
    ['org-abcd', 'shared'],
    ['legacy__shared', 'shared'],
    ['ses-abcd', 'isolated-small'],
    ['istd-abcd', 'isolated-standard'],
    ['crv-abcd', 'code-review'],
    ['dind-abcd', 'devcontainer'],
    ['private-invalid', 'unknown'],
  ])(
    'derives only the authoritative allocation classification for %s',
    (sandboxId, sandboxType) => {
      expect(initialRuntimeMetadata(sandboxId)).toEqual({
        sandboxType,
        kiloCliVersion: null,
        wrapperVersion: null,
        startedAt: null,
        stoppedAt: null,
      });
    }
  );

  it.each([
    ['standard-3', 'containers-standard-3'],
    ['standard-4', 'containers-standard-4'],
  ] as const)('projects the containers instance %s as sandbox type %s', (instance, sandboxType) => {
    expect(initialRuntimeMetadata('ses-abcd', instance)).toEqual({
      sandboxType,
      kiloCliVersion: null,
      wrapperVersion: null,
      startedAt: null,
      stoppedAt: null,
    });
  });

  it('round-trips metadata independently of physical lifecycle writes and erases it on deletion', async () => {
    const storage = memoryStorage();
    expect(await loadRuntimeMetadata(storage)).toBeUndefined();
    const runtime = {
      ...initialRuntimeMetadata('istd-abcd'),
      wrapperVersion: '2.4.0',
      kiloCliVersion: '7.4.20',
    };
    await saveRuntimeMetadata(storage, runtime);
    await storeAllocation(storage, allocationFixture({ state: 'stopped' })!);
    expect(await loadRuntimeMetadata(storage)).toEqual(runtime);
    expect((await loadAllocation(storage)).state.kind).toBe('stopped');
    await eraseSandboxRecord(storage);
    expect(await loadRuntimeMetadata(storage)).toBeUndefined();
  });

  it('does not backfill or reflect malformed stored runtime metadata', async () => {
    const storage = memoryStorage();
    await storeAllocation(storage, allocationFixture({ state: 'stopped' })!);
    for (const runtime of [
      undefined,
      {},
      { ...initialRuntimeMetadata('ses-abcd'), wrapperVersion: 'private-error' },
    ]) {
      await storage.put('runtime_metadata', runtime);
      expect(await loadRuntimeMetadata(storage)).toBeUndefined();
      expect((await loadAllocation(storage)).state.kind).toBe('stopped');
      expect(await storage.get('runtime_metadata')).toEqual(runtime);
    }
  });

  it('loads no credential grants from a pre-worktree record', async () => {
    expect(await loadSessionCredentialGrants(memoryStorage())).toEqual([]);
  });

  it('round-trips multiple roots in a worktree grant alongside a legacy session-scoped grant', async () => {
    const storage = memoryStorage();
    const grants = [
      credentialGrant(),
      {
        ...credentialGrant(),
        scopeId: LEGACY_SESSION_ID,
        directory: '/workspace/legacy',
        members: [{ sessionId: LEGACY_SESSION_ID, kiloSessionId: LEGACY_ROOT_ID }],
      },
    ];
    await saveSessionCredentialGrants(storage, grants);
    expect(await loadSessionCredentialGrants(storage)).toStrictEqual(grants);
  });

  it('round-trips a direct credential grant without losing its scope or containment choice', async () => {
    const storage = memoryStorage();
    const contained = credentialGrant();
    const grant = {
      ...contained,
      containmentEnabled: false,
      kilo: {
        token: contained.kilo.token,
        targets: contained.kilo.targets,
        capabilities: {},
      },
    } satisfies SessionCredentialGrant;
    await saveSessionCredentialGrants(storage, [grant]);
    expect(await loadSessionCredentialGrants(storage)).toStrictEqual([grant]);
  });

  it('rejects a persisted direct grant carrying a contained alias', async () => {
    const storage = memoryStorage();
    await storage.put('worktree_credential_grants', [
      { ...credentialGrant(), containmentEnabled: false },
    ]);
    await expect(loadSessionCredentialGrants(storage)).rejects.toThrow(
      'Invalid stored worktree credentials'
    );
  });

  it.each([
    { version: 2 },
    { scopeId: '' },
    { members: [] },
    {
      members: [
        { sessionId: SESSION_ID, kiloSessionId: ROOT_ID },
        { sessionId: SECOND_SESSION_ID, kiloSessionId: ROOT_ID },
      ],
    },
  ])('rejects malformed persisted credential grants: %j', async overrides => {
    const storage = memoryStorage();
    await storage.put('worktree_credential_grants', [{ ...credentialGrant(), ...overrides }]);
    await expect(loadSessionCredentialGrants(storage)).rejects.toThrow(
      'Invalid stored worktree credentials'
    );
  });

  it('rejects a non-array persisted credential state', async () => {
    const storage = memoryStorage();
    await storage.put('worktree_credential_grants', credentialGrant());
    await expect(loadSessionCredentialGrants(storage)).rejects.toThrow(
      'Invalid stored worktree credentials'
    );
  });

  it('preserves shared-directory and legacy routes across a durable reload', async () => {
    const storage = memoryStorage();
    const grant = credentialGrant();
    const table = emptyRouteTable();
    for (const member of grant.members) {
      attachRoute(
        table,
        {
          ...member,
          ownerId: grant.userId,
          directory: grant.directory,
          worktreeId: grant.scopeId,
        },
        grant.userId
      );
    }
    const legacy = {
      sessionId: LEGACY_SESSION_ID,
      kiloSessionId: LEGACY_ROOT_ID,
      ownerId: grant.userId,
      directory: '/workspace/legacy',
    };
    attachRoute(table, legacy, grant.userId);
    await saveRouteTable(storage, table);

    const loaded = await loadRouteTable(storage);
    expect(loaded).toStrictEqual(table);
    expect(resolveSessionEventRoute(loaded, { directory: grant.directory })).toBeNull();
    expect(
      resolveSessionEventRoute(loaded, {
        directory: grant.directory,
        rootKiloSessionId: SECOND_ROOT_ID,
        kiloSessionId: 'kilo_child',
      })?.sessionId
    ).toBe(SECOND_SESSION_ID);
    expect(resolveSessionEventRoute(loaded, { directory: legacy.directory })?.sessionId).toBe(
      LEGACY_SESSION_ID
    );
    expect(attachRoute(loaded, legacy, grant.userId).changed).toBe(false);
  });

  it('erases credential grants along with the sandbox record without clearing unrelated storage', async () => {
    const storage = memoryStorage();
    const grant = credentialGrant();
    await saveSessionCredentialGrants(storage, [grant]);
    await storeAllocation(
      storage,
      allocationFixture({
        state: 'running',
        providerRef: 'ref_1',
        createIntent: {
          intentId: 'intent_1',
          createdAt: 1000,
          containment: WORKTREE_CREDENTIAL_CONTAINMENT,
        },
        containment: { providerRef: 'ref_1', ...WORKTREE_CREDENTIAL_CONTAINMENT },
      })!
    );
    const { table } = attachRoute(
      emptyRouteTable(),
      {
        sessionId: SESSION_ID,
        kiloSessionId: ROOT_ID,
        directory: grant.directory,
        worktreeId: grant.scopeId,
        ownerId: grant.userId,
      },
      grant.userId
    );
    await saveRouteTable(storage, table);
    await saveSessionReferences(
      storage,
      markReferencesReconciled(
        addSessionReference(emptySessionReferenceState(), {
          sessionId: grant.scopeId,
          kiloSessionId: ROOT_ID,
          directory: grant.directory,
          worktreeId: grant.scopeId,
        }).state
      )
    );
    await saveTransitionLog(storage, [{ at: 1001, kind: 'physical', to: 'running' }]);
    await storage.put('owner', grant.userId);

    await eraseSandboxRecord(storage);

    expect(await loadSessionCredentialGrants(storage)).toEqual([]);
    expect((await loadAllocation(storage)).state.kind).toBe('stopped');
    expect(await loadRouteTable(storage)).toEqual(emptyRouteTable());
    expect(await loadSessionReferences(storage)).toEqual(emptySessionReferenceState());
    expect(await loadTransitionLog(storage)).toEqual([]);
    expect(await storage.get('owner')).toBe(grant.userId);
  });

  it('erases infrastructure alarm anchors so a deleted runtime cannot re-arm them', async () => {
    const storage = memoryStorage();
    await storage.put(CONTROL_ALARM_ANCHORS_KEY, {
      credentialExpiryAt: 5_000,
      socketHandshakeAt: 6_000,
    });
    await storage.put(LEGACY_CONTROL_DEADLINES_KEY, {
      credentialExpiry: 5_000,
      socketHandshake: 6_000,
    });

    await eraseSandboxRecord(storage);

    expect(await storage.get(CONTROL_ALARM_ANCHORS_KEY)).toBeUndefined();
    expect(await storage.get(LEGACY_CONTROL_DEADLINES_KEY)).toBeUndefined();
  });

  it('defaults absent session references to the empty state and round-trips a reconciled index', async () => {
    const storage = memoryStorage();
    expect(await loadSessionReferences(storage)).toEqual(emptySessionReferenceState());
    const state = emptySessionReferenceState();
    addSessionReference(state, {
      sessionId: SESSION_ID,
      kiloSessionId: ROOT_ID,
      directory: '/workspace/paths/org/project/worktree_11111111-1111-4111-8111-111111111111',
    });
    addSessionReference(state, {
      sessionId: 'workspace_other',
      kiloSessionId: 'ses_other',
      directory: '/workspace/paths/org/other',
      worktreeId: 'worktree_22222222-2222-4222-8222-222222222222',
    });
    markReferencesReconciled(state);

    await saveSessionReferences(storage, state);

    expect(await loadSessionReferences(storage)).toEqual(state);
  });

  it('rejects malformed session references instead of defaulting to the empty state', async () => {
    const storage = memoryStorage();
    for (const value of [
      { reconciled: 'yes', overflowed: false, entries: [] },
      {
        reconciled: true,
        overflowed: false,
        entries: [{ sessionId: SESSION_ID, kiloSessionId: ROOT_ID }],
      },
      {
        reconciled: true,
        overflowed: false,
        entries: [{ sessionId: SESSION_ID, kiloSessionId: ROOT_ID, directory: '', extra: 'field' }],
      },
    ]) {
      await storage.put(SESSION_REFERENCES_KEY, value);
      await expect(loadSessionReferences(storage)).rejects.toThrow();
    }
  });

  it('rejects a persisted session reference index over the entry or byte limit', async () => {
    const storage = memoryStorage();
    const entry = (index: number, directory: string) => ({
      sessionId: `ses_${index}`,
      kiloSessionId: `kilo_${index}`,
      directory,
    });
    await storage.put(SESSION_REFERENCES_KEY, {
      reconciled: false,
      overflowed: false,
      entries: Array.from({ length: MAX_REFERENCE_ENTRIES + 1 }, (_, index) => entry(index, 'd')),
    });
    await expect(loadSessionReferences(storage)).rejects.toThrow();

    const oversized = Array.from({ length: 200 }, (_, index) => entry(index, 'd'.repeat(512)));
    expect(serializedReferenceBytes(oversized)).toBeGreaterThan(MAX_REFERENCE_BYTES);
    await storage.put(SESSION_REFERENCES_KEY, {
      reconciled: false,
      overflowed: false,
      entries: oversized,
    });
    await expect(loadSessionReferences(storage)).rejects.toThrow();
  });
});
