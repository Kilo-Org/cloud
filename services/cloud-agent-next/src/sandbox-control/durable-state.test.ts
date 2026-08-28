import { describe, expect, it } from 'vitest';
import {
  eraseSandboxRecord,
  loadDeadlines,
  loadPhysicalRecord,
  loadRouteTable,
  loadSessionCredentialGrants,
  loadTransitionLog,
  saveDeadlines,
  savePhysicalRecord,
  saveRouteTable,
  saveSessionCredentialGrants,
  saveTransitionLog,
} from './durable-state.js';
import { createControlPlaneCredential } from './managed-credential.js';
import {
  claimCreate,
  confirmRunning,
  initialPhysicalRecord,
  WORKTREE_CREDENTIAL_CONTAINMENT,
} from './physical-lifecycle.js';
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
    await savePhysicalRecord(
      storage,
      confirmRunning(
        claimCreate(
          initialPhysicalRecord(false),
          'intent_1',
          1000,
          undefined,
          WORKTREE_CREDENTIAL_CONTAINMENT
        ),
        'ref_1',
        1001
      )
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
    await saveDeadlines(storage, { heartbeatExpiry: 3000 });
    await saveTransitionLog(storage, [{ at: 1001, kind: 'physical', to: 'running' }]);
    await storage.put('owner', grant.userId);

    await eraseSandboxRecord(storage);

    expect(await loadSessionCredentialGrants(storage)).toEqual([]);
    expect(await loadPhysicalRecord(storage)).toStrictEqual(initialPhysicalRecord(false));
    expect(await loadRouteTable(storage)).toEqual(emptyRouteTable());
    expect(await loadDeadlines(storage)).toEqual({});
    expect(await loadTransitionLog(storage)).toEqual([]);
    expect(await storage.get('owner')).toBe(grant.userId);
  });
});
