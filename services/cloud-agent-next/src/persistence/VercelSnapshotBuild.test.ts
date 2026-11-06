import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { vercelSnapshotBuilds } from '../db/vercel-snapshot-schema.js';
import {
  hashSandboxCredential,
  verifySandboxLaunchCredential,
} from '../sandbox-control/credential.js';
import { encodeVercelProviderRef } from '../sandbox-control/vercel-provider.js';
import { RUNTIME_TOOLCHAIN } from '../shared/runtime-toolchain.js';
import snapshotMigrations from '../../drizzle/vercel-snapshot/migrations.js';
import * as runtimeBase from '../byoc/vercel-runtime-base.js';
import {
  snapshotValidatorAllocation,
  type SnapshotValidatorInput,
} from '../control-plane/sandbox/snapshot-validator.js';

const mocks = vi.hoisted(() => {
  class CredentialMissingError extends Error {}
  class CredentialResolverError extends Error {}
  class SandboxRestError extends Error {
    constructor(
      readonly kind: string,
      readonly operation: string,
      readonly status?: number
    ) {
      super(`${kind}:${operation}`);
    }
  }

  const client = {
    inspectTeam: vi.fn(),
    inspectProject: vi.fn(),
    createSandbox: vi.fn(),
    inspectByName: vi.fn(),
    executeCommand: vi.fn(),
    writeFiles: vi.fn(),
    listCommands: vi.fn(),
    getCommand: vi.fn(),
    stopSession: vi.fn(),
    getSession: vi.fn(),
    listSnapshots: vi.fn(),
    inspectSnapshot: vi.fn(),
    createSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
  };

  return {
    CredentialMissingError,
    CredentialResolverError,
    SandboxRestError,
    client,
    control: {
      initializeSnapshotValidator: vi.fn(),
      confirmSnapshotValidatorStopped: vi.fn(),
      getSnapshotValidatorStatus: vi.fn(),
    },
    getControl: vi.fn(),
    fetchCredential: vi.fn(),
    resolveAccess: vi.fn(),
    projectStatus: vi.fn(),
    downloadedStartup: vi.fn(),
    getIdentity: vi.fn(),
  };
});

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  },
}));

vi.mock('../../drizzle/vercel-snapshot/migrations', async () => {
  const { readFileSync } = await import('node:fs');
  const journal = JSON.parse(
    readFileSync(
      new URL('../../drizzle/vercel-snapshot/meta/_journal.json', import.meta.url).pathname,
      'utf8'
    )
  );

  return {
    default: {
      journal,
      migrations: {
        m0000: readFileSync(
          new URL('../../drizzle/vercel-snapshot/0000_vercel_snapshot_build.sql', import.meta.url)
            .pathname,
          'utf8'
        ),
        m0001: readFileSync(
          new URL('../../drizzle/vercel-snapshot/0001_runtime_recipe.sql', import.meta.url)
            .pathname,
          'utf8'
        ),
      },
    },
  };
});

vi.mock('../byoc/vercel-credential-resolver.js', () => ({
  ByocCredentialMissingError: mocks.CredentialMissingError,
  ByocCredentialResolverError: mocks.CredentialResolverError,
  fetchByocVercelCredential: mocks.fetchCredential,
  resolveByocVercelAccessConfig: mocks.resolveAccess,
  projectByocVercelStatus: mocks.projectStatus,
}));

vi.mock('../sandbox-control/downloaded-startup.js', () => ({
  downloadedStartup: mocks.downloadedStartup,
}));

vi.mock('../byoc/vercel-runtime-identity.js', () => ({
  getVercelRuntimeIdentity: mocks.getIdentity,
  VERCEL_RUNTIME_BUN_VERSION: '1.3.14',
  VERCEL_RUNTIME_KILO_CLI_VERSION: '7.4.20',
}));

vi.mock('../agent-sandbox/vercel/vercel-sandbox-rest-client.js', () => ({
  VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG: 'kilo-create-operation',
  VERCEL_CLOUD_AGENT_RESOURCE_TAG: 'kilo-managed-by',
  VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE: 'cloud-agent-session',
  VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG: 'kilo-runtime-build',
  VercelSandboxRestError: mocks.SandboxRestError,
  VercelSandboxRestClient: class VercelSandboxRestClient {
    constructor() {
      Object.assign(this, mocks.client);
    }
  },
}));

vi.mock('../utils/do-retry.js', () => ({
  withDORetry: async (
    getStub: () => unknown,
    operation: (stub: unknown) => Promise<unknown>
  ): Promise<unknown> => operation(getStub()),
}));

vi.mock('../logger.js', () => ({
  logger: {
    withFields: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

const { VercelSnapshotBuild } = await import('./VercelSnapshotBuild.js');
const {
  ownerCredentialFetchInput,
  ownerFromInput,
  ownerFromRow,
  ownerToProjection,
  ownerToRowKey,
} = await import('../byoc/vercel-snapshot-owner.js');

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_GENERATION = '33333333-3333-4333-8333-333333333333';
const SECOND_GENERATION = '44444444-4444-4444-8444-444444444444';
const THIRD_GENERATION = '55555555-5555-4555-8555-555555555555';
const PERSONAL_USER_ID = 'oauth/vercel-user';

type BuildRow = typeof vercelSnapshotBuilds.$inferSelect;
type BuildChanges = Partial<typeof vercelSnapshotBuilds.$inferInsert>;
type ManagedSandboxKind = 'builder' | 'validator';
type BuildOwnerInput = { organizationId: string } | { userId: string };

type StorageFixture = ReturnType<typeof createStorage>;
type BuildFixture = {
  database: DatabaseSync;
  storage: StorageFixture;
  build: InstanceType<typeof VercelSnapshotBuild>;
};

function makeCredential(
  buildGeneration = FIRST_GENERATION,
  owner: BuildOwnerInput = { organizationId: ORGANIZATION_ID }
) {
  return {
    ...owner,
    credentialId: CREDENTIAL_ID,
    buildGeneration,
    runtimeBuildId: `runtime-${buildGeneration}`,
  };
}

function startInput(
  buildGeneration = FIRST_GENERATION,
  owner: BuildOwnerInput = { organizationId: ORGANIZATION_ID }
) {
  return {
    ...owner,
    credentialId: CREDENTIAL_ID,
    buildGeneration,
  };
}

function createStorage(database: DatabaseSync) {
  let alarm: number | null = null;

  return {
    sql: {
      exec(query: string, ...parameters: unknown[]) {
        const statement = database.prepare(query);
        const columns = statement.columns().map(column => column.name);
        const rows = statement.all(...(parameters as never[]));
        const iterator = rows[Symbol.iterator]();

        return {
          next: () => iterator.next(),
          toArray: () => rows,
          raw: () => ({
            toArray: () => rows.map(row => columns.map(column => row[column])),
          }),
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(action: () => T): T {
      database.exec('BEGIN');
      try {
        const result = action();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    setAlarm: vi.fn(async (timestamp: number | Date) => {
      alarm = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    }),
    deleteAlarm: vi.fn(async () => {
      alarm = null;
    }),
    getAlarm: vi.fn(async () => alarm),
  };
}

function createBuild(
  storage: StorageFixture,
  ownerKey = ORGANIZATION_ID,
  runtimeDescriptor = 'a'.repeat(64)
): InstanceType<typeof VercelSnapshotBuild> {
  const ctx = {
    id: { name: ownerKey },
    storage,
    blockConcurrencyWhile: vi.fn((action: () => Promise<void>) => action()),
  };
  const env = {
    WORKER_URL: 'https://worker.invalid',
    NEXTAUTH_SECRET: 'snapshot-test-signing-secret',
    RUNTIME_RELEASE_DESCRIPTOR: runtimeDescriptor,
    SANDBOX_CONTROL: { getByName: mocks.getControl },
  };
  return new VercelSnapshotBuild(ctx as never, env as never);
}

function createFixture(): BuildFixture {
  const database = new DatabaseSync(':memory:');
  const storage = createStorage(database);
  return { database, storage, build: createBuild(storage) };
}

function storedRow(fixture: BuildFixture): BuildRow | undefined {
  return storedRowAt(fixture, ORGANIZATION_ID);
}

function storedRowAt(fixture: BuildFixture, ownerKey: string): BuildRow | undefined {
  return drizzle(fixture.storage as never)
    .select()
    .from(vercelSnapshotBuilds)
    .where(eq(vercelSnapshotBuilds.organization_id, ownerKey))
    .get();
}

function updateRow(fixture: BuildFixture, changes: BuildChanges, ownerKey = ORGANIZATION_ID): void {
  drizzle(fixture.storage as never)
    .update(vercelSnapshotBuilds)
    .set(changes)
    .where(eq(vercelSnapshotBuilds.organization_id, ownerKey))
    .run();
}

async function runNextAlarm(fixture: BuildFixture): Promise<void> {
  const state = storedRow(fixture);
  expect(state?.next_attempt_at).toEqual(expect.any(Number));
  expect(await fixture.storage.getAlarm()).not.toBeNull();
  updateRow(fixture, { next_attempt_at: Date.now() - 1 });
  await fixture.build.alarm();
}

function prepareCreation(fixture: BuildFixture, kind: ManagedSandboxKind, requested = 1): BuildRow {
  if (kind === 'builder') {
    updateRow(fixture, { step: 'create_builder', builder_create_requested: requested });
  } else {
    updateRow(fixture, {
      step: 'create_validator',
      builder_session_id: 'builder-snapshotted',
      snapshot_id: 'snapshot-source',
      validator_create_requested: requested,
    });
  }

  const state = storedRow(fixture);
  if (!state) throw new Error('Expected pending managed sandbox creation');
  return state;
}

function createdSandbox(state: BuildRow, kind: ManagedSandboxKind, sessionId: string) {
  const sandboxName = kind === 'builder' ? state.builder_name : state.validator_name;
  const operation = kind === 'builder' ? state.builder_operation_id : state.validator_operation_id;

  return {
    sandbox: {
      name: sandboxName,
      currentSessionId: sessionId,
      status: 'running',
      persistent: false,
      createdAt: 0,
      updatedAt: 0,
      tags: {
        'kilo-managed-by': 'cloud-agent-session',
        'kilo-create-operation': operation,
        'kilo-runtime-build': state.runtime_build_id,
      },
    },
    session: {
      id: sessionId,
      sourceSandboxName: sandboxName,
      projectId: 'project-test',
      ...(kind === 'validator' ? { sourceSnapshotId: state.snapshot_id } : {}),
      runtime: 'node24',
      status: 'running',
      memory: 2048,
      vcpus: 2,
      region: 'iad1',
      timeout: 600_000,
      requestedAt: 0,
      cwd: '/',
      createdAt: 0,
      updatedAt: 0,
    },
    routes: [],
    runtime: { sandboxName, sessionId },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getControl.mockImplementation(() => mocks.control);
  mocks.fetchCredential.mockResolvedValue(makeCredential());
  mocks.resolveAccess.mockResolvedValue({
    accessToken: 'test-vercel-credential',
    teamId: 'team-test',
    projectId: 'project-test',
  });
  mocks.projectStatus.mockResolvedValue(true);
  mocks.control.initializeSnapshotValidator.mockResolvedValue(undefined);
  mocks.control.confirmSnapshotValidatorStopped.mockResolvedValue(undefined);
  mocks.control.getSnapshotValidatorStatus.mockResolvedValue({
    physical: 'running',
    connection: 'ready',
  });
  mocks.client.getSession.mockImplementation(async () => ({
    session: { status: 'running', requestedAt: Date.now(), timeout: 600_000 },
  }));
  mocks.client.inspectTeam.mockResolvedValue({ id: 'team-test', slug: 'team-test' });
  mocks.client.inspectProject.mockResolvedValue({ id: 'project-test', name: 'project-test' });
  mocks.client.inspectByName.mockResolvedValue(null);
  mocks.client.listSnapshots.mockResolvedValue([]);
  mocks.client.stopSession.mockResolvedValue({ status: 'stopped' });
  mocks.client.deleteSnapshot.mockResolvedValue(undefined);
  mocks.client.writeFiles.mockResolvedValue(undefined);
  mocks.client.executeCommand.mockImplementation(async (_sessionId, input) =>
    input.wait === false
      ? { id: 'command-test', exitCode: null }
      : {
          command: { id: 'command-test', exitCode: null },
          finished: { id: 'command-test', exitCode: 0 },
        }
  );
  mocks.getIdentity.mockResolvedValue({
    wrapperVersion: '2.4.0',
    releasedAt: '2026-09-08',
    digest: 'digest-test',
  });
  mocks.downloadedStartup.mockResolvedValue({
    argv: ['/bin/sh', '-c', 'download-runtime-and-exec-supervisor'],
    user: 'root',
  });
});

describe('VercelSnapshotBuild persistence isolation', () => {
  it('parses the actual migration module without mocked imports', () => {
    const result = spawnSync(
      process.execPath,
      ['--check', new URL('../../drizzle/vercel-snapshot/migrations.js', import.meta.url).pathname],
      { encoding: 'utf8' }
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
  it('migrates legacy build rows without certifying their runtime recipe', async () => {
    const source = createFixture();
    await source.build.start(startInput());
    const state = storedRow(source);
    const database = new DatabaseSync(':memory:');
    const storage = createStorage(database);
    const db = drizzle(storage as never);
    await migrate(db, {
      ...snapshotMigrations,
      journal: {
        ...snapshotMigrations.journal,
        entries: snapshotMigrations.journal.entries.slice(0, 1),
      },
    });
    const legacy = Object.entries({
      ...state,
      step: 'confirm_terminal',
      snapshot_id: 'legacy-baked-snapshot',
    }).filter(([name]) => name !== 'recipe_digest');
    database
      .prepare(
        `INSERT INTO vercel_snapshot_builds (${legacy.map(([name]) => name).join(',')}) VALUES (${legacy.map(() => '?').join(',')})`
      )
      .run(...legacy.map(([, value]) => value as never));
    await migrate(db, snapshotMigrations);
    expect(db.select().from(vercelSnapshotBuilds).get()).toMatchObject({
      recipe_digest: null,
      step: 'confirm_terminal',
      snapshot_id: 'legacy-baked-snapshot',
    });
    const build = createBuild(storage);
    await build.alarm();
    expect(db.select().from(vercelSnapshotBuilds).get()).toMatchObject({
      step: 'validating_access',
      snapshot_id: null,
    });
    expect(mocks.getIdentity).not.toHaveBeenCalled();
  });

  it('applies snapshot-only migrations without adding snapshot tables to session migrations', async () => {
    const snapshot = createFixture();
    const snapshotTables = snapshot.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(row => row.name);

    expect(snapshotTables).toContain('vercel_snapshot_builds');
    expect(snapshotTables).not.toContain('events');
    expect(snapshotTables).not.toContain('command_queue');
    expect(snapshotTables).not.toContain('execution_leases');

    const sessionDatabase = new DatabaseSync(':memory:');
    const sessionStorage = createStorage(sessionDatabase);
    const journal = JSON.parse(
      readFileSync(
        new URL('../control-plane/session/drizzle/meta/_journal.json', import.meta.url).pathname,
        'utf8'
      )
    ) as {
      entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
    };
    const migrations = Object.fromEntries(
      journal.entries.map(entry => [
        `m${String(entry.idx).padStart(4, '0')}`,
        readFileSync(
          new URL(`../control-plane/session/drizzle/${entry.tag}.sql`, import.meta.url).pathname,
          'utf8'
        ),
      ])
    );

    await migrate(drizzle(sessionStorage as never), { journal, migrations });

    const sessionTables = sessionDatabase
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(row => row.name);
    expect(sessionTables).toEqual(expect.arrayContaining(['events', 'control_plane_messages']));
    expect(sessionTables).not.toContain('vercel_snapshot_builds');
  });

  it('maps personal owners to prefixed rows and owner-shaped resolver inputs', () => {
    const owner = { type: 'user' as const, userId: PERSONAL_USER_ID };

    expect(ownerToRowKey(owner)).toBe(`user:${PERSONAL_USER_ID}`);
    expect(
      ownerFromRow({ organization_id: `user:${PERSONAL_USER_ID}`, owner_type: 'user' })
    ).toEqual(owner);
    expect(ownerFromRow({ organization_id: ORGANIZATION_ID, owner_type: 'org' })).toEqual({
      type: 'org',
      organizationId: ORGANIZATION_ID,
    });
    expect(ownerToProjection(owner)).toEqual({ userId: PERSONAL_USER_ID });
    expect(ownerCredentialFetchInput(owner, CREDENTIAL_ID)).toEqual({
      userId: PERSONAL_USER_ID,
      credentialId: CREDENTIAL_ID,
    });
    expect(ownerFromInput(startInput(FIRST_GENERATION, { userId: PERSONAL_USER_ID }))).toEqual(
      owner
    );
  });

  it('persists and cleans personal snapshot builds through the user-keyed row', async () => {
    const database = new DatabaseSync(':memory:');
    const storage = createStorage(database);
    const build = createBuild(storage, `user:${PERSONAL_USER_ID}`);
    const input = startInput(FIRST_GENERATION, { userId: PERSONAL_USER_ID });
    mocks.fetchCredential.mockResolvedValueOnce(
      makeCredential(FIRST_GENERATION, { userId: PERSONAL_USER_ID })
    );

    await build.start(input);

    expect(storedRowAt({ database, storage, build }, `user:${PERSONAL_USER_ID}`)).toMatchObject({
      organization_id: `user:${PERSONAL_USER_ID}`,
      owner_type: 'user',
      credential_id: CREDENTIAL_ID,
    });
    expect(mocks.fetchCredential).toHaveBeenCalledWith(expect.anything(), {
      userId: PERSONAL_USER_ID,
      credentialId: CREDENTIAL_ID,
    });

    await build.cleanup(input);

    expect(storedRowAt({ database, storage, build }, `user:${PERSONAL_USER_ID}`)).toBeUndefined();
  });

  it('uses persisted personal ownership for alarm projection', async () => {
    const database = new DatabaseSync(':memory:');
    const storage = createStorage(database);
    const build = createBuild(storage, `user:${PERSONAL_USER_ID}`);
    const input = startInput(FIRST_GENERATION, { userId: PERSONAL_USER_ID });
    mocks.fetchCredential.mockResolvedValueOnce(
      makeCredential(FIRST_GENERATION, { userId: PERSONAL_USER_ID })
    );

    await build.start(input);
    updateRow(
      { database, storage, build },
      { next_attempt_at: Date.now() - 1 },
      `user:${PERSONAL_USER_ID}`
    );
    await build.alarm();

    expect(mocks.projectStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: PERSONAL_USER_ID,
        credentialId: CREDENTIAL_ID,
        setupStatus: 'building',
      })
    );
  });

  it('rejects a persisted owner discriminator that disagrees with the row key before lookup', async () => {
    const database = new DatabaseSync(':memory:');
    const storage = createStorage(database);
    const build = createBuild(storage, `user:${PERSONAL_USER_ID}`);
    await build.start(startInput(FIRST_GENERATION, { userId: PERSONAL_USER_ID }));
    updateRow(
      { database, storage, build },
      { owner_type: 'org', next_attempt_at: Date.now() - 1 },
      `user:${PERSONAL_USER_ID}`
    );
    mocks.fetchCredential.mockClear();
    mocks.control.initializeSnapshotValidator.mockClear();

    await expect(build.alarm()).rejects.toThrow('snapshot_owner_row_key_mismatch');

    expect(mocks.fetchCredential).not.toHaveBeenCalled();
    expect(mocks.control.initializeSnapshotValidator).not.toHaveBeenCalled();
  });
});

describe('VercelSnapshotBuild token scope', () => {
  it('does not inspect team metadata for a project-scoped credential', async () => {
    const fixture = createFixture();
    mocks.resolveAccess.mockResolvedValueOnce({
      accessToken: 'test-vercel-credential',
      teamId: 'team-test',
      scope: 'project',
      projectId: 'project-test',
    });

    await fixture.build.start(startInput());
    await fixture.build.alarm();

    expect(mocks.client.inspectTeam).not.toHaveBeenCalled();
    expect(mocks.client.inspectProject).toHaveBeenCalledOnce();
  });
});

describe('VercelSnapshotBuild ownership fencing', () => {
  it('re-arms a persisted build when the first start could not set its alarm', async () => {
    const fixture = createFixture();
    fixture.storage.setAlarm.mockRejectedValueOnce(new Error('alarm unavailable'));
    await expect(fixture.build.start(startInput())).rejects.toThrow('alarm unavailable');
    expect(await fixture.storage.getAlarm()).toBeNull();

    await fixture.build.start(startInput());
    await runNextAlarm(fixture);

    expect(storedRow(fixture)?.team_slug).toBe('team-test');
  });

  it('retries failed generation handover cleanup without a new start request', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-old' });
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 503)
    );
    await expect(fixture.build.start(startInput(SECOND_GENERATION))).rejects.toMatchObject({
      status: 503,
    });
    expect(storedRow(fixture)).toMatchObject({ step: 'cleanup' });
    expect(storedRow(fixture)?.next_attempt_at).not.toBeNull();
    await runNextAlarm(fixture);
    expect(storedRow(fixture)).toBeUndefined();

    await fixture.build.start(startInput(SECOND_GENERATION));
    await runNextAlarm(fixture);

    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      runtime_build_id: `runtime-${SECOND_GENERATION}`,
      builder_session_id: null,
      team_slug: 'team-test',
    });
  });

  it('deletes a superseded snapshot before advancing a replacement with the same credential', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { snapshot_id: 'snapshot-superseded' });
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));

    await fixture.build.start(startInput(SECOND_GENERATION));

    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-superseded');
    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      snapshot_id: null,
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('retains the superseded builder until fenced replacement cleanup confirms it stopped', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-old' });
    const previous = storedRow(fixture);
    if (!previous) throw new Error('Expected previous build state');

    const stopping = deferred<{ status: string }>();
    mocks.client.stopSession.mockImplementationOnce(() => stopping.promise);
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    const replacement = fixture.build.start(startInput(SECOND_GENERATION));
    await vi.waitFor(() => expect(mocks.client.stopSession).toHaveBeenCalledOnce());

    expect(mocks.client.stopSession).toHaveBeenCalledWith('builder-old', previous.builder_name);
    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      builder_session_id: 'builder-old',
      builder_name: previous.builder_name,
      next_attempt_at: null,
    });

    stopping.resolve({ status: 'stopped' });
    await replacement;

    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      builder_session_id: null,
      step: 'validating_access',
    });
  });

  it('preserves superseded sessions and propagates replacement cleanup failures', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-old' });
    const previous = storedRow(fixture);
    if (!previous) throw new Error('Expected previous build state');

    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 503)
    );

    await expect(fixture.build.start(startInput(SECOND_GENERATION))).rejects.toMatchObject({
      operation: 'stop-session',
      status: 503,
    });

    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      builder_session_id: 'builder-old',
      builder_name: previous.builder_name,
      step: 'cleanup',
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();

    await runNextAlarm(fixture);

    expect(mocks.client.stopSession).toHaveBeenCalledTimes(2);
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('does not allow a delayed replacement start to overwrite newer ownership', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());

    const staleCredential = deferred<ReturnType<typeof makeCredential>>();
    mocks.fetchCredential.mockImplementationOnce(() => staleCredential.promise);
    const staleStart = fixture.build.start(startInput(SECOND_GENERATION));

    mocks.fetchCredential.mockResolvedValueOnce(makeCredential(THIRD_GENERATION));
    await fixture.build.start(startInput(THIRD_GENERATION));

    staleCredential.resolve(makeCredential(SECOND_GENERATION));
    await staleStart;

    expect(storedRow(fixture)?.build_generation).toBe(THIRD_GENERATION);
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(2);
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('prevents a stale alarm from projecting, overwriting, or rearming newer ownership', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());

    const inspection = deferred<{ id: string; slug: string }>();
    mocks.client.inspectTeam.mockImplementationOnce(() => inspection.promise);
    const staleAlarm = fixture.build.alarm();
    await vi.waitFor(() => expect(mocks.client.inspectTeam).toHaveBeenCalledOnce());

    mocks.fetchCredential.mockResolvedValueOnce(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    const armedByReplacement = fixture.storage.setAlarm.mock.calls.length;

    inspection.resolve({ id: 'team-test', slug: 'stale-team' });
    await staleAlarm;

    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      step: 'validating_access',
      team_slug: null,
    });
    expect(mocks.projectStatus).not.toHaveBeenCalled();
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(armedByReplacement);
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('does not let a stale missing-credential alarm erase or cancel a replacement', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());

    const lookup = deferred<ReturnType<typeof makeCredential>>();
    mocks.fetchCredential.mockImplementationOnce(() => lookup.promise);
    const staleAlarm = fixture.build.alarm();

    mocks.fetchCredential.mockResolvedValueOnce(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    lookup.reject(new mocks.CredentialMissingError('removed'));
    await staleAlarm;

    expect(storedRow(fixture)?.build_generation).toBe(SECOND_GENERATION);
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('removes a detached snapshot without allowing its stale alarm to mutate a newer generation', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'snapshot_builder',
      snapshot_source_session_id: 'builder-session',
      snapshot_baseline_json: '[]',
      snapshot_requested: 1,
    });

    const pendingSnapshot = deferred<{
      id: string;
      sourceSessionId: string;
      status: string;
    }>();
    mocks.client.createSnapshot.mockImplementationOnce(() => pendingSnapshot.promise);
    const staleAlarm = fixture.build.alarm();
    await vi.waitFor(() => expect(mocks.client.createSnapshot).toHaveBeenCalledOnce());

    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    pendingSnapshot.resolve({
      id: 'snapshot-detached',
      sourceSessionId: 'builder-session',
      status: 'created',
    });
    await staleAlarm;

    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-detached');
    expect(storedRow(fixture)?.build_generation).toBe(SECOND_GENERATION);
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });
});

describe('VercelSnapshotBuild create-intent cleanup', () => {
  it.each(['builder', 'validator'] as const)(
    'cleans up a definitively rejected %s create without retaining its intent',
    async kind => {
      for (const status of [400, 401, 403]) {
        const fixture = createFixture();
        await fixture.build.start(startInput());
        prepareCreation(fixture, kind);
        mocks.client.createSandbox.mockRejectedValueOnce(
          new mocks.SandboxRestError('request_failed', 'create', status)
        );

        await runNextAlarm(fixture);
        expect(storedRow(fixture)).toMatchObject({
          step: 'project_failure',
          ...(kind === 'builder'
            ? { builder_create_requested: 0 }
            : { validator_create_requested: 0 }),
        });
        await runNextAlarm(fixture);
        expect(storedRow(fixture)).toBeUndefined();
      }
    }
  );

  it.each(['builder', 'validator'] as const)(
    'clears a rate-limited %s create intent so retry and cleanup can recover',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      prepareCreation(fixture, kind);
      mocks.client.createSandbox.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'create', 429)
      );
      await runNextAlarm(fixture);
      expect(storedRow(fixture)).toMatchObject({
        retry_count: 1,
        ...(kind === 'builder'
          ? { builder_create_requested: 0 }
          : { validator_create_requested: 0 }),
      });
      await fixture.build.cleanup(startInput());
      expect(storedRow(fixture)).toBeUndefined();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'retains the %s create intent after an ambiguous server failure',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      prepareCreation(fixture, kind);
      mocks.client.createSandbox.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'create', 503)
      );

      await runNextAlarm(fixture);
      expect(storedRow(fixture)).toMatchObject(
        kind === 'builder' ? { builder_create_requested: 2 } : { validator_create_requested: 2 }
      );
      await expect(fixture.build.cleanup(startInput())).rejects.toMatchObject({
        operation: 'inspect',
      });
    }
  );

  it.each(['builder', 'validator'] as const)(
    'allows an absent prepared %s intent to be canceled before provider creation',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      const state = prepareCreation(fixture, kind);

      await fixture.build.cleanup(startInput());

      expect(mocks.client.inspectByName).toHaveBeenCalledWith(
        expect.objectContaining({
          name: kind === 'builder' ? state.builder_name : state.validator_name,
          operationId:
            kind === 'builder' ? state.builder_operation_id : state.validator_operation_id,
          runtimeBuildId: state.runtime_build_id,
          source:
            kind === 'builder'
              ? { type: 'runtime' }
              : { type: 'snapshot', snapshotId: 'snapshot-source' },
        })
      );
      expect(mocks.client.stopSession).not.toHaveBeenCalled();
      expect(storedRow(fixture)).toBeUndefined();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'retains an ambiguous dispatched %s intent when named inspection returns not found',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      prepareCreation(fixture, kind, 2);

      await expect(fixture.build.cleanup(startInput())).rejects.toMatchObject({
        kind: 'request_failed',
        operation: 'inspect',
      });

      expect(storedRow(fixture)).toMatchObject(
        kind === 'builder' ? { builder_create_requested: 2 } : { validator_create_requested: 2 }
      );
      expect(mocks.client.stopSession).not.toHaveBeenCalled();
      expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
      expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'reconciles and stops only the exactly tagged managed %s session',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      const state = prepareCreation(fixture, kind, 2);
      const sessionId = `${kind}-recovered`;
      mocks.client.inspectByName.mockResolvedValueOnce(createdSandbox(state, kind, sessionId));

      await fixture.build.cleanup(startInput());

      expect(mocks.client.stopSession).toHaveBeenCalledWith(
        sessionId,
        kind === 'builder' ? state.builder_name : state.validator_name
      );
      expect(storedRow(fixture)).toBeUndefined();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'retains a %s intent when provider identity does not correlate',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      prepareCreation(fixture, kind, 2);
      mocks.client.inspectByName.mockRejectedValueOnce(
        new mocks.SandboxRestError('correlation_mismatch', 'inspect')
      );

      await expect(fixture.build.cleanup(startInput())).rejects.toMatchObject({
        kind: 'correlation_mismatch',
        operation: 'inspect',
      });

      expect(storedRow(fixture)).toBeDefined();
      expect(mocks.client.stopSession).not.toHaveBeenCalled();
      expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'preserves a %s creation intent when provider reconciliation fails',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      prepareCreation(fixture, kind, 2);
      mocks.client.inspectByName.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'inspect', 503)
      );

      await expect(fixture.build.cleanup(startInput())).rejects.toMatchObject({
        operation: 'inspect',
        status: 503,
      });

      expect(storedRow(fixture)).toMatchObject(
        kind === 'builder' ? { builder_create_requested: 2 } : { validator_create_requested: 2 }
      );
      expect(mocks.client.stopSession).not.toHaveBeenCalled();
      expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'reconciles the previous %s intent during a fenced generation handover',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      const previous = prepareCreation(fixture, kind, 2);
      const sessionId = `${kind}-superseded`;
      mocks.client.inspectByName.mockResolvedValueOnce(createdSandbox(previous, kind, sessionId));
      mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));

      await fixture.build.start(startInput(SECOND_GENERATION));

      expect(mocks.client.inspectByName).toHaveBeenCalledWith(
        expect.objectContaining({
          name: kind === 'builder' ? previous.builder_name : previous.validator_name,
          operationId:
            kind === 'builder' ? previous.builder_operation_id : previous.validator_operation_id,
          runtimeBuildId: previous.runtime_build_id,
        })
      );
      expect(mocks.client.stopSession).toHaveBeenCalledWith(
        sessionId,
        kind === 'builder' ? previous.builder_name : previous.validator_name
      );
      expect(storedRow(fixture)).toMatchObject({
        build_generation: SECOND_GENERATION,
        builder_create_requested: 0,
        validator_create_requested: 0,
        builder_session_id: null,
        validator_session_id: null,
      });
    }
  );

  it.each(['builder', 'validator'] as const)(
    'stops a late %s create result after replacement and retains its exact session for retry',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      const previous = prepareCreation(fixture, kind);
      const sessionId = `${kind}-late`;
      const creation = deferred<ReturnType<typeof createdSandbox>>();
      mocks.client.createSandbox.mockImplementationOnce(() => creation.promise);

      const staleAlarm = fixture.build.alarm();
      await vi.waitFor(() => expect(mocks.client.createSandbox).toHaveBeenCalledOnce());
      expect(storedRow(fixture)).toMatchObject(
        kind === 'builder' ? { builder_create_requested: 2 } : { validator_create_requested: 2 }
      );

      mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
      await expect(fixture.build.start(startInput(SECOND_GENERATION))).rejects.toMatchObject({
        operation: 'inspect',
      });
      expect(storedRow(fixture)?.build_generation).toBe(SECOND_GENERATION);
      expect(mocks.client.stopSession).not.toHaveBeenCalled();

      creation.resolve(createdSandbox(previous, kind, sessionId));
      await staleAlarm;

      expect(mocks.client.stopSession).toHaveBeenCalledWith(
        sessionId,
        kind === 'builder' ? previous.builder_name : previous.validator_name
      );
      expect(storedRow(fixture)).toMatchObject({
        build_generation: SECOND_GENERATION,
        ...(kind === 'builder'
          ? { builder_session_id: sessionId }
          : { validator_session_id: sessionId }),
      });
      expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();

      await fixture.build.cleanup(startInput(SECOND_GENERATION));

      expect(storedRow(fixture)).toBeUndefined();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'idempotently stops a late %s create result after its owner was canceled',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      const previous = prepareCreation(fixture, kind);
      const sessionId = `${kind}-canceled`;
      const envelope = createdSandbox(previous, kind, sessionId);
      const creation = deferred<ReturnType<typeof createdSandbox>>();
      mocks.client.createSandbox.mockImplementationOnce(() => creation.promise);

      const staleAlarm = fixture.build.alarm();
      await vi.waitFor(() => expect(mocks.client.createSandbox).toHaveBeenCalledOnce());
      mocks.client.inspectByName.mockResolvedValueOnce(envelope);

      await fixture.build.cleanup(startInput());

      expect(storedRow(fixture)).toBeUndefined();
      mocks.client.stopSession.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'stop-session', kind === 'builder' ? 404 : 410)
      );
      creation.resolve(envelope);
      await staleAlarm;

      expect(mocks.client.stopSession.mock.calls).toEqual([
        [sessionId, kind === 'builder' ? previous.builder_name : previous.validator_name],
        [sessionId, kind === 'builder' ? previous.builder_name : previous.validator_name],
      ]);
      expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
    }
  );

  it.each(['builder', 'validator'] as const)(
    'retains a late %s session when detached provider stop fails',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      const previous = prepareCreation(fixture, kind);
      const sessionId = `${kind}-retained`;
      const creation = deferred<ReturnType<typeof createdSandbox>>();
      mocks.client.createSandbox.mockImplementationOnce(() => creation.promise);

      const staleAlarm = fixture.build.alarm();
      await vi.waitFor(() => expect(mocks.client.createSandbox).toHaveBeenCalledOnce());
      mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
      await expect(fixture.build.start(startInput(SECOND_GENERATION))).rejects.toMatchObject({
        operation: 'inspect',
      });
      mocks.client.stopSession.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'stop-session', 503)
      );

      creation.resolve(createdSandbox(previous, kind, sessionId));
      await staleAlarm;

      expect(storedRow(fixture)).toMatchObject({
        build_generation: SECOND_GENERATION,
        ...(kind === 'builder'
          ? { builder_session_id: sessionId }
          : { validator_session_id: sessionId }),
      });
      expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();

      await fixture.build.cleanup(startInput(SECOND_GENERATION));

      expect(storedRow(fixture)).toBeUndefined();
    }
  );

  it('never stops a detached sandbox whose managed generation tags do not match', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    const previous = prepareCreation(fixture, 'builder');
    const creation = deferred<ReturnType<typeof createdSandbox>>();
    mocks.client.createSandbox.mockImplementationOnce(() => creation.promise);

    const staleAlarm = fixture.build.alarm();
    await vi.waitFor(() => expect(mocks.client.createSandbox).toHaveBeenCalledOnce());
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await expect(fixture.build.start(startInput(SECOND_GENERATION))).rejects.toMatchObject({
      operation: 'inspect',
    });

    const untrusted = createdSandbox(previous, 'builder', 'customer-session');
    untrusted.sandbox.tags['kilo-create-operation'] = 'customer-owned';
    creation.resolve(untrusted);
    await staleAlarm;

    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      builder_create_requested: 2,
      builder_session_id: null,
    });
  });

  it('never stops a session already attributed to a newer generation', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    const previous = prepareCreation(fixture, 'builder');
    const sessionId = 'newer-generation-session';
    const creation = deferred<ReturnType<typeof createdSandbox>>();
    mocks.client.createSandbox.mockImplementationOnce(() => creation.promise);

    const staleAlarm = fixture.build.alarm();
    await vi.waitFor(() => expect(mocks.client.createSandbox).toHaveBeenCalledOnce());
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await expect(fixture.build.start(startInput(SECOND_GENERATION))).rejects.toMatchObject({
      operation: 'inspect',
    });
    updateRow(fixture, {
      runtime_build_id: `runtime-${SECOND_GENERATION}`,
      builder_name: 'ses-newer-generation',
      builder_operation_id: 'byoc-builder-newer-generation',
      builder_session_id: sessionId,
      builder_create_requested: 1,
    });

    creation.resolve(createdSandbox(previous, 'builder', sessionId));
    await staleAlarm;

    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      builder_session_id: sessionId,
    });
  });

  it('does not reuse removed credentials for detached sandbox cleanup', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    const previous = prepareCreation(fixture, 'builder');
    const envelope = createdSandbox(previous, 'builder', 'builder-canceled');
    const creation = deferred<ReturnType<typeof createdSandbox>>();
    mocks.client.createSandbox.mockImplementationOnce(() => creation.promise);

    const staleAlarm = fixture.build.alarm();
    await vi.waitFor(() => expect(mocks.client.createSandbox).toHaveBeenCalledOnce());
    mocks.client.inspectByName.mockResolvedValueOnce(envelope);
    await fixture.build.cleanup(startInput());
    mocks.fetchCredential.mockRejectedValueOnce(new mocks.CredentialMissingError('removed'));

    creation.resolve(envelope);
    await staleAlarm;

    expect(mocks.client.stopSession).toHaveBeenCalledOnce();
    expect(storedRow(fixture)).toBeUndefined();
  });
});

describe('VercelSnapshotBuild cleanup', () => {
  it('stops the exact builder when cancellation occurs before a snapshot exists', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'install_system_dependencies',
      builder_session_id: 'builder-canceled',
    });
    const state = storedRow(fixture);
    if (!state) throw new Error('Expected active builder');

    await fixture.build.cleanup(startInput());

    expect(mocks.client.stopSession).toHaveBeenCalledOnce();
    expect(mocks.client.stopSession).toHaveBeenCalledWith('builder-canceled', state.builder_name);
    expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });

  it('stops each known validator and unsnapshotted builder using its exact persisted name', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      builder_session_id: 'builder-canceled',
      validator_session_id: 'validator-canceled',
    });
    const state = storedRow(fixture);
    if (!state) throw new Error('Expected active setup sessions');

    await fixture.build.cleanup(startInput());

    expect(mocks.client.stopSession.mock.calls).toEqual([
      ['validator-canceled', state.validator_name],
      ['builder-canceled', state.builder_name],
    ]);
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('stops the validator but skips a builder already terminated by snapshot creation', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      builder_session_id: 'builder-snapshotted',
      validator_session_id: 'validator-active',
      snapshot_id: 'snapshot-ready',
    });
    const state = storedRow(fixture);
    if (!state) throw new Error('Expected active validator');

    await fixture.build.cleanup(startInput());

    expect(mocks.client.stopSession.mock.calls).toEqual([
      ['validator-active', state.validator_name],
    ]);
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-ready');
    expect(storedRow(fixture)).toBeUndefined();
  });

  it.each(['stopped', 'failed', 'aborted'])(
    'accepts the terminal provider stop state %s',
    async status => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      updateRow(fixture, { builder_session_id: 'builder-terminal' });
      mocks.client.stopSession.mockResolvedValueOnce({ status });

      await fixture.build.cleanup(startInput());

      expect(storedRow(fixture)).toBeUndefined();
      expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
    }
  );

  it.each([404, 410])('treats provider stop status %s as already terminal', async status => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-absent' });
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', status)
    );

    await fixture.build.cleanup(startInput());

    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });

  it.each([403, 503])(
    'propagates provider stop status %s without losing the session or alarm',
    async status => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      updateRow(fixture, { builder_session_id: 'builder-retained' });
      mocks.client.stopSession.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'stop-session', status)
      );

      await expect(fixture.build.cleanup(startInput())).rejects.toMatchObject({
        operation: 'stop-session',
        status,
      });

      expect(storedRow(fixture)?.builder_session_id).toBe('builder-retained');
      expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  );

  it('rejects a nonterminal stop result and retains cleanup ownership', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { validator_session_id: 'validator-running' });
    mocks.client.stopSession.mockResolvedValueOnce({ status: 'stopping' });

    await expect(fixture.build.cleanup(startInput())).rejects.toMatchObject({
      kind: 'request_failed',
      operation: 'stop-session',
    });

    expect(storedRow(fixture)?.validator_session_id).toBe('validator-running');
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('retains stopped-session references when later snapshot deletion fails', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      builder_session_id: 'builder-retry',
      snapshot_candidate_id: 'snapshot-retry',
    });
    mocks.client.deleteSnapshot.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'delete-snapshot', 503)
    );

    await expect(fixture.build.cleanup(startInput())).rejects.toMatchObject({
      operation: 'delete-snapshot',
      status: 503,
    });
    expect(storedRow(fixture)).toMatchObject({
      builder_session_id: 'builder-retry',
      snapshot_candidate_id: 'snapshot-retry',
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();

    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 404)
    );
    await fixture.build.cleanup(startInput());

    expect(mocks.client.stopSession).toHaveBeenCalledTimes(2);
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledTimes(2);
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('deletes a successful PostgreSQL snapshot without requiring local build state', async () => {
    const fixture = createFixture();
    const input = { ...startInput(), snapshotId: 'snapshot-ready' };

    await fixture.build.cleanup(input);
    mocks.client.deleteSnapshot.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'delete-snapshot', 404)
    );
    await expect(fixture.build.cleanup(input)).resolves.toBeUndefined();

    expect(mocks.client.deleteSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-ready');
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('deduplicates persisted IDs and reconciles in-flight snapshots before erasing its owner', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'snapshot_builder',
      snapshot_candidate_id: 'snapshot-candidate',
      snapshot_source_session_id: 'builder-session',
      snapshot_baseline_json: JSON.stringify(['snapshot-existing']),
      snapshot_requested: 2,
    });
    mocks.client.listSnapshots.mockResolvedValueOnce([
      { id: 'snapshot-existing', sourceSessionId: 'builder-session', status: 'created' },
      { id: 'snapshot-candidate', sourceSessionId: 'builder-session', status: 'created' },
      { id: 'snapshot-recovered', sourceSessionId: 'builder-session', status: 'created' },
      { id: 'snapshot-unrelated', sourceSessionId: 'other-session', status: 'created' },
    ]);

    await fixture.build.cleanup({ ...startInput(), snapshotId: 'snapshot-candidate' });

    expect(mocks.client.deleteSnapshot.mock.calls.map(([snapshotId]) => snapshotId).sort()).toEqual(
      ['snapshot-candidate', 'snapshot-recovered']
    );
    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });

  it('never lets stale cleanup delete a newer snapshot or cancel its alarm', async () => {
    const fixture = createFixture();
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    updateRow(fixture, { snapshot_id: 'snapshot-newer' });
    mocks.fetchCredential.mockClear();

    await fixture.build.cleanup({ ...startInput(), snapshotId: 'snapshot-newer' });

    expect(mocks.fetchCredential).not.toHaveBeenCalled();
    expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
    expect(storedRow(fixture)?.snapshot_id).toBe('snapshot-newer');
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('does not cancel a replacement alarm when cleanup loses ownership during provider I/O', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { snapshot_id: 'snapshot-superseded' });

    const deletion = deferred<void>();
    mocks.client.deleteSnapshot.mockImplementationOnce(() => deletion.promise);
    const staleCleanup = fixture.build.cleanup(startInput());
    await vi.waitFor(() => expect(mocks.client.deleteSnapshot).toHaveBeenCalledOnce());

    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    const replacementAlarmCount = fixture.storage.setAlarm.mock.calls.length;
    deletion.resolve();
    await staleCleanup;

    expect(storedRow(fixture)?.build_generation).toBe(SECOND_GENERATION);
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(replacementAlarmCount);
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('never stops builder or validator sessions owned by a newer generation', async () => {
    const fixture = createFixture();
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    updateRow(fixture, {
      builder_session_id: 'builder-newer',
      validator_session_id: 'validator-newer',
    });

    await fixture.build.cleanup(startInput());

    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      builder_session_id: 'builder-newer',
      validator_session_id: 'validator-newer',
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('stops processing stale session cleanup after ownership changes during provider I/O', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      builder_session_id: 'builder-old',
      validator_session_id: 'validator-old',
    });

    const stopping = deferred<{ status: string }>();
    mocks.client.stopSession.mockImplementationOnce(() => stopping.promise);
    const staleCleanup = fixture.build.cleanup(startInput());
    await vi.waitFor(() => expect(mocks.client.stopSession).toHaveBeenCalledOnce());

    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    updateRow(fixture, {
      builder_session_id: 'builder-newer',
      validator_session_id: 'validator-newer',
    });
    stopping.resolve({ status: 'stopped' });
    await staleCleanup;

    expect(mocks.client.stopSession.mock.calls.map(([sessionId]) => sessionId)).not.toContain(
      'builder-newer'
    );
    expect(mocks.client.stopSession.mock.calls.map(([sessionId]) => sessionId)).not.toContain(
      'validator-newer'
    );
    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      builder_session_id: 'builder-newer',
      validator_session_id: 'validator-newer',
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('erases only its own state when credentials are missing without issuing provider cleanup', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      builder_session_id: 'builder-unreachable',
      validator_session_id: 'validator-unreachable',
      snapshot_id: 'snapshot-unreachable',
    });
    mocks.fetchCredential.mockRejectedValueOnce(new mocks.CredentialMissingError('removed'));

    await fixture.build.cleanup({ ...startInput(), snapshotId: 'snapshot-unreachable' });

    expect(mocks.resolveAccess).not.toHaveBeenCalled();
    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });

  it('does not attempt provider stop when an alarm discovers credentials were removed', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-unreachable' });
    mocks.fetchCredential.mockRejectedValueOnce(new mocks.CredentialMissingError('removed'));

    await fixture.build.alarm();

    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });

  it('stops a failed validator and deletes its snapshot without restopping the builder', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'verify_validator_call_home',
      builder_session_id: 'builder-snapshotted',
      validator_session_id: 'validator-failed',
      validator_wrapper_command_id: 'validator-command',
      validator_control_id: 'validator-control',
      snapshot_id: 'snapshot-failed',
    });
    const state = storedRow(fixture);
    if (!state) throw new Error('Expected active validator');
    mocks.client.getCommand.mockResolvedValueOnce({ exitCode: 1 });

    await fixture.build.alarm();
    await runNextAlarm(fixture);

    expect(mocks.projectStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ setupStatus: 'failed' })
    );
    expect(mocks.client.stopSession.mock.calls).toEqual([
      ['validator-failed', state.validator_name],
    ]);
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-failed');
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('replays failed builder cleanup from its alarm without rerunning the failed build step', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-failed' });
    mocks.client.inspectTeam.mockRejectedValueOnce(new Error('setup_command_failed'));
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 503)
    );

    await fixture.build.alarm();
    expect(storedRow(fixture)).toMatchObject({
      step: 'project_failure',
      last_error: 'setup_command_failed',
      next_attempt_at: expect.any(Number),
    });
    await runNextAlarm(fixture);

    expect(storedRow(fixture)).toMatchObject({
      step: 'cleanup',
      builder_session_id: 'builder-failed',
      last_error: 'setup_command_failed',
      next_attempt_at: expect.any(Number),
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();

    await runNextAlarm(fixture);

    expect(mocks.client.inspectTeam).toHaveBeenCalledOnce();
    expect(mocks.projectStatus).toHaveBeenCalledOnce();
    expect(mocks.client.stopSession).toHaveBeenCalledTimes(2);
    expect(storedRow(fixture)).toBeUndefined();
    expect(await fixture.storage.getAlarm()).toBeNull();
  });

  it('deletes failed snapshots while their credential remains available', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { snapshot_id: 'snapshot-failed' });
    mocks.client.inspectTeam.mockRejectedValueOnce(new Error('deterministic-failure'));

    await fixture.build.alarm();
    await runNextAlarm(fixture);

    expect(mocks.projectStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ setupStatus: 'failed', runtimeSnapshotId: null })
    );
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-failed');
    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });
});

describe('VercelSnapshotBuild terminal replay', () => {
  it('replays projection and cleanup after restart beyond the original build lifetime without changing the public failure', async () => {
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      updateRow(fixture, {
        step: 'verify_validator_call_home',
        snapshot_id: 'snapshot-overdue',
        validator_session_id: 'validator-overdue',
        validator_wrapper_command_id: 'validator-command',
        validator_control_id: 'validator-control',
      });
      mocks.client.getCommand.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'get-command', 403)
      );
      await fixture.build.alarm();
      const failed = storedRow(fixture);
      if (!failed) throw new Error('Expected durable terminal projection');
      mocks.projectStatus.mockRejectedValueOnce(new mocks.CredentialResolverError('unavailable'));
      mocks.client.stopSession.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'stop-session', 503)
      );
      mocks.client.deleteSnapshot.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'delete-snapshot', 503)
      );

      for (const [index, step] of ['project_failure', 'cleanup', 'cleanup'].entries()) {
        clock.mockReturnValue(startedAt + (index + 1) * 2 * 60 * 60_000);
        fixture.build = createBuild(fixture.storage);
        await fixture.build.alarm();
        const retained = storedRow(fixture);
        expect(retained).toMatchObject({
          step,
          created_at: startedAt,
          build_generation: FIRST_GENERATION,
          last_error: 'byoc_vercel_forbidden',
          snapshot_id: failed.snapshot_id,
          validator_session_id: failed.validator_session_id,
          validator_name: failed.validator_name,
          validator_operation_id: failed.validator_operation_id,
          validator_control_id: failed.validator_control_id,
        });
        expect(retained?.next_attempt_at).toBeGreaterThan(Date.now());
        expect(await fixture.storage.getAlarm()).toBe(retained?.next_attempt_at);
      }

      clock.mockReturnValue(startedAt + 8 * 60 * 60_000);
      fixture.build = createBuild(fixture.storage);
      mocks.client.stopSession.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'stop-session', 404)
      );
      await fixture.build.alarm();

      expect(storedRow(fixture)).toBeUndefined();
      expect(await fixture.storage.getAlarm()).toBeNull();
      expect(mocks.client.getCommand).toHaveBeenCalledOnce();
      expect(mocks.client.createSandbox).not.toHaveBeenCalled();
      expect(mocks.client.stopSession.mock.calls).toEqual([
        ['validator-overdue', failed.validator_name],
        ['validator-overdue', failed.validator_name],
        ['validator-overdue', failed.validator_name],
      ]);
      expect(mocks.client.deleteSnapshot.mock.calls).toEqual([
        ['snapshot-overdue'],
        ['snapshot-overdue'],
      ]);
      expect(mocks.projectStatus).toHaveBeenCalledTimes(2);
      for (const [, projection] of mocks.projectStatus.mock.calls) {
        expect(projection).toMatchObject({
          organizationId: ORGANIZATION_ID,
          credentialId: CREDENTIAL_ID,
          buildGeneration: FIRST_GENERATION,
          setupStatus: 'failed',
          setupStep: null,
          setupError: 'byoc_vercel_forbidden',
          runtimeSnapshotId: null,
          setupStartedAt: new Date(startedAt).toISOString(),
          setupCompletedAt: null,
        });
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('retains the original safe failure and resources through repeated projection failures', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'verify_validator_call_home',
      snapshot_id: 'snapshot-failed',
      validator_session_id: 'validator-failed',
      validator_wrapper_command_id: 'validator-command',
      validator_control_id: 'validator-control',
    });
    mocks.client.getCommand.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'get-command', 403)
    );
    await fixture.build.alarm();
    const failed = storedRow(fixture);
    mocks.projectStatus.mockRejectedValue(new mocks.CredentialResolverError('unavailable'));

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runNextAlarm(fixture);
      expect(storedRow(fixture)).toMatchObject({
        step: 'project_failure',
        build_generation: FIRST_GENERATION,
        snapshot_id: 'snapshot-failed',
        validator_session_id: 'validator-failed',
        validator_name: failed?.validator_name,
        last_error: 'byoc_vercel_forbidden',
        next_attempt_at: expect.any(Number),
      });
    }
    expect(mocks.client.getCommand).toHaveBeenCalledOnce();
    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
    expect(
      mocks.projectStatus.mock.calls.every(
        ([, projection]) =>
          projection.setupStatus === 'failed' && projection.setupError === 'byoc_vercel_forbidden'
      )
    ).toBe(true);

    mocks.projectStatus.mockResolvedValue(true);
    await runNextAlarm(fixture);

    expect(mocks.client.stopSession).toHaveBeenCalledWith(
      'validator-failed',
      failed?.validator_name
    );
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-failed');
    expect(storedRow(fixture)).toBeUndefined();
    expect(await fixture.storage.getAlarm()).toBeNull();
  });

  it('retries snapshot deletion after the failure projection and validator stop are complete', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'verify_validator_call_home',
      snapshot_id: 'snapshot-failed',
      validator_session_id: 'validator-failed',
      validator_wrapper_command_id: 'validator-command',
      validator_control_id: 'validator-control',
    });
    mocks.client.getCommand.mockResolvedValueOnce({ exitCode: 1 });
    mocks.client.deleteSnapshot.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'delete-snapshot', 503)
    );
    await fixture.build.alarm();
    await runNextAlarm(fixture);

    expect(storedRow(fixture)).toMatchObject({
      step: 'cleanup',
      snapshot_id: 'snapshot-failed',
      validator_session_id: 'validator-failed',
      last_error: 'validator_call_home_failed',
      next_attempt_at: expect.any(Number),
    });
    expect(mocks.control.confirmSnapshotValidatorStopped).toHaveBeenCalledOnce();
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 404)
    );
    await runNextAlarm(fixture);

    expect(mocks.projectStatus).toHaveBeenCalledOnce();
    expect(mocks.client.getCommand).toHaveBeenCalledOnce();
    expect(mocks.client.deleteSnapshot.mock.calls).toEqual([
      ['snapshot-failed'],
      ['snapshot-failed'],
    ]);
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('continues abandoned-generation cleanup without projecting a new failure', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-superseded' });
    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 503)
    );

    await fixture.build.alarm();
    expect(storedRow(fixture)).toMatchObject({
      step: 'cleanup',
      build_generation: FIRST_GENERATION,
      builder_session_id: 'builder-superseded',
      next_attempt_at: expect.any(Number),
    });
    await runNextAlarm(fixture);

    expect(mocks.projectStatus).not.toHaveBeenCalled();
    expect(mocks.client.inspectTeam).not.toHaveBeenCalled();
    expect(mocks.client.stopSession).toHaveBeenCalledTimes(2);
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('does not let a delayed terminal projection touch replacement resources or scheduling', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { snapshot_id: 'snapshot-old' });
    mocks.client.inspectTeam.mockRejectedValueOnce(new Error('setup_command_failed'));
    await fixture.build.alarm();
    const projection = deferred<boolean>();
    mocks.projectStatus.mockImplementationOnce(() => projection.promise);
    const staleAlarm = runNextAlarm(fixture);
    await vi.waitFor(() => expect(mocks.projectStatus).toHaveBeenCalledOnce());

    mocks.fetchCredential.mockResolvedValue(makeCredential(SECOND_GENERATION));
    await fixture.build.start(startInput(SECOND_GENERATION));
    updateRow(fixture, { snapshot_id: 'snapshot-new', validator_session_id: 'validator-new' });
    const alarmCount = fixture.storage.setAlarm.mock.calls.length;
    projection.reject(new mocks.CredentialResolverError('unavailable'));
    await staleAlarm;

    expect(storedRow(fixture)).toMatchObject({
      build_generation: SECOND_GENERATION,
      step: 'validating_access',
      snapshot_id: 'snapshot-new',
      validator_session_id: 'validator-new',
    });
    expect(mocks.client.deleteSnapshot.mock.calls).toEqual([['snapshot-old']]);
    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(alarmCount);
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('erases local terminal state when credentials disappear without attempting provider cleanup', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-inaccessible' });
    mocks.client.inspectTeam.mockRejectedValueOnce(new Error('setup_command_failed'));
    await fixture.build.alarm();
    mocks.fetchCredential.mockRejectedValue(new mocks.CredentialMissingError('removed'));

    await runNextAlarm(fixture);

    expect(storedRow(fixture)).toBeUndefined();
    expect(mocks.client.stopSession).not.toHaveBeenCalled();
    expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
    expect(await fixture.storage.getAlarm()).toBeNull();
  });
});

describe('VercelSnapshotBuild runtime preparation', () => {
  it('changes validator control and allocation incarnations when the same generation changes recipe', async () => {
    const recipe = vi
      .spyOn(runtimeBase, 'vercelRuntimeBaseDigest')
      .mockResolvedValue('old-base-recipe');
    try {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      updateRow(fixture, {
        step: 'launch_validator_wrapper',
        snapshot_id: 'old-base-snapshot',
        validator_session_id: 'old-validator-session',
      });
      await fixture.build.alarm();
      const oldControlId = storedRow(fixture)?.validator_control_id;
      const oldAllocationId = mocks.downloadedStartup.mock.calls[0]?.[0].allocationId;
      recipe.mockResolvedValue('new-base-recipe');
      await runNextAlarm(fixture);
      expect(storedRow(fixture)?.step).toBe('validating_access');
      updateRow(fixture, {
        step: 'launch_validator_wrapper',
        snapshot_id: 'current-base-snapshot',
        validator_session_id: 'current-validator-session',
      });
      await fixture.build.alarm();
      expect(storedRow(fixture)?.step).toBe('verify_validator_call_home');
      expect(storedRow(fixture)?.validator_control_id).not.toBe(oldControlId);
      expect(mocks.downloadedStartup.mock.calls[1]?.[0].allocationId).not.toBe(oldAllocationId);
      expect(
        mocks.control.initializeSnapshotValidator.mock.calls.map(
          ([input]) => input.build.generation
        )
      ).toEqual([FIRST_GENERATION, FIRST_GENERATION]);
    } finally {
      recipe.mockRestore();
    }
  });

  it.each(['legacy', 'previous-recipe'])(
    'restarts a %s build without rebinding its preinitialized validator',
    async kind => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      const oldAllocationId =
        kind === 'legacy' ? FIRST_GENERATION : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const oldControlId = `ses-byoc-validator-${oldAllocationId.replaceAll('-', '')}`;
      const oldProviderRef = encodeVercelProviderRef({
        sandboxName: 'legacy-validator',
        sessionId: 'legacy-validator-session',
      });
      const registered = new Map([[oldControlId, oldProviderRef]]);
      mocks.getControl.mockImplementation((sandboxId: string) => ({
        ...mocks.control,
        initializeSnapshotValidator: async (input: SnapshotValidatorInput) => {
          snapshotValidatorAllocation(sandboxId, input, Date.now());
          const providerRef = registered.get(sandboxId);
          if (providerRef && providerRef !== input.allocation.providerRef)
            throw new Error('Snapshot validator allocation changed');
          registered.set(sandboxId, input.allocation.providerRef);
          await mocks.control.initializeSnapshotValidator(input);
        },
      }));
      updateRow(fixture, {
        step: 'verify_validator_call_home',
        recipe_digest: kind === 'legacy' ? null : 'previous-recipe',
        validator_control_id: oldControlId,
        validator_name: 'legacy-validator',
        validator_session_id: 'legacy-validator-session',
        snapshot_id: 'legacy-baked-snapshot',
      });
      await fixture.build.alarm();
      expect(mocks.control.confirmSnapshotValidatorStopped).toHaveBeenCalledWith(oldProviderRef);
      expect(storedRow(fixture)?.step).toBe('validating_access');
      updateRow(fixture, {
        step: 'launch_validator_wrapper',
        snapshot_id: 'current-base-snapshot',
        validator_session_id: 'current-validator-session',
      });
      await fixture.build.alarm();
      const current = storedRow(fixture);
      expect(current?.step).toBe('verify_validator_call_home');
      expect(current?.validator_control_id).not.toBe(oldControlId);
      expect(registered.get(oldControlId)).toBe(oldProviderRef);
      const input = mocks.control.initializeSnapshotValidator.mock.calls[0]?.[0];
      expect(input.build.generation).toBe(FIRST_GENERATION);
      expect(input.build.incarnation).not.toBe(oldAllocationId);
      expect(mocks.downloadedStartup).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: current?.validator_control_id,
          allocationId: input.build.incarnation,
        })
      );
      expect(registered.size).toBe(2);
    }
  );

  it('keeps the incarnation of a persisted in-progress legacy validator', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    const sandboxId = `ses-byoc-validator-${FIRST_GENERATION.replaceAll('-', '')}`;
    updateRow(fixture, {
      step: 'launch_validator_wrapper',
      validator_control_id: sandboxId,
      snapshot_id: 'current-base-snapshot',
      validator_session_id: 'current-validator-session',
    });
    await fixture.build.alarm();
    expect(storedRow(fixture)?.step).toBe('verify_validator_call_home');
    expect(mocks.downloadedStartup).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId, allocationId: FIRST_GENERATION })
    );
    expect(mocks.control.initializeSnapshotValidator).toHaveBeenCalledWith(
      expect.objectContaining({
        build: expect.objectContaining({
          generation: FIRST_GENERATION,
          incarnation: FIRST_GENERATION,
        }),
      })
    );
  });

  it('fences an old recipe snapshot response after restarting the same generation', async () => {
    const recipe = vi.spyOn(runtimeBase, 'vercelRuntimeBaseDigest').mockResolvedValue('old-recipe');
    try {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      updateRow(fixture, {
        step: 'snapshot_builder',
        builder_session_id: 'legacy-builder-session',
        snapshot_source_session_id: 'legacy-builder-session',
        snapshot_baseline_json: '[]',
        snapshot_requested: 1,
      });
      const pendingSnapshot = deferred<{ id: string; sourceSessionId: string; status: string }>();
      mocks.client.createSnapshot.mockImplementationOnce(() => pendingSnapshot.promise);
      const staleAlarm = fixture.build.alarm();
      await vi.waitFor(() => expect(mocks.client.createSnapshot).toHaveBeenCalledOnce());
      recipe.mockResolvedValue('current-recipe');
      await fixture.build.alarm();
      expect(storedRow(fixture)).toMatchObject({
        step: 'validating_access',
        recipe_digest: 'current-recipe',
        snapshot_id: null,
      });
      pendingSnapshot.resolve({
        id: 'late-baked-snapshot',
        sourceSessionId: 'legacy-builder-session',
        status: 'created',
      });
      await staleAlarm;
      expect(storedRow(fixture)).toMatchObject({
        step: 'validating_access',
        recipe_digest: 'current-recipe',
        snapshot_id: null,
      });
      expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('late-baked-snapshot');
      expect(mocks.projectStatus).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ setupStatus: 'ready' })
      );
    } finally {
      recipe.mockRestore();
    }
  });

  it.each([
    'snapshot_builder',
    'create_validator',
    'launch_validator_wrapper',
    'verify_validator_call_home',
    'stop_validator',
    'confirm_terminal',
  ])('restarts unproven persisted %s builds without publishing their old snapshots', async step => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step,
      recipe_digest: null,
      builder_name: 'legacy-builder',
      builder_operation_id: 'legacy-builder-operation',
      builder_session_id: 'legacy-builder-session',
      validator_name: 'legacy-validator',
      validator_operation_id: 'legacy-validator-operation',
      validator_session_id: step === 'snapshot_builder' ? null : 'legacy-validator-session',
      validator_control_id: step === 'snapshot_builder' ? null : 'legacy-validator-control',
      snapshot_id: step === 'snapshot_builder' ? null : 'legacy-baked-snapshot',
      snapshot_candidate_id: step === 'snapshot_builder' ? 'legacy-baked-snapshot' : null,
    });
    await fixture.build.alarm();
    expect(storedRow(fixture)).toMatchObject({
      step: 'validating_access',
      recipe_digest: expect.stringMatching(/^downloaded-base-v1:[a-f0-9]{64}$/),
      builder_session_id: null,
      validator_session_id: null,
      snapshot_id: null,
      snapshot_candidate_id: null,
    });
    expect(storedRow(fixture)?.builder_name).not.toBe('legacy-builder');
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('legacy-baked-snapshot');
    expect(mocks.client.stopSession).toHaveBeenCalledWith(
      step === 'snapshot_builder' ? 'legacy-builder-session' : 'legacy-validator-session',
      step === 'snapshot_builder' ? 'legacy-builder' : 'legacy-validator'
    );
    expect(mocks.getIdentity).not.toHaveBeenCalled();
    expect(mocks.projectStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ setupStatus: 'ready' })
    );
    const cleanupCalls = mocks.client.stopSession.mock.calls.length;
    fixture.build = createBuild(fixture.storage);
    await runNextAlarm(fixture);
    expect(storedRow(fixture)?.builder_name).not.toBe('legacy-builder');
    expect(mocks.client.stopSession).toHaveBeenCalledTimes(cleanupCalls);
  });

  it('retries fenced cleanup before restarting an incompatible recipe', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'confirm_terminal',
      recipe_digest: 'old-recipe',
      snapshot_id: 'legacy-baked-snapshot',
      validator_session_id: 'legacy-validator-session',
    });
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 503)
    );
    await fixture.build.alarm();
    expect(storedRow(fixture)).toMatchObject({
      step: 'restart_recipe',
      recipe_digest: 'old-recipe',
      snapshot_id: 'legacy-baked-snapshot',
      validator_session_id: 'legacy-validator-session',
    });
    expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
    expect(mocks.getIdentity).not.toHaveBeenCalled();
    await runNextAlarm(fixture);
    expect(storedRow(fixture)).toMatchObject({
      step: 'validating_access',
      snapshot_id: null,
      validator_session_id: null,
    });
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('legacy-baked-snapshot');
  });

  it('fails a missing runtime release before creating a billable builder', async () => {
    const database = new DatabaseSync(':memory:');
    const storage = createStorage(database);
    const build = createBuild(storage, ORGANIZATION_ID, '');
    const fixture = { database, storage, build };
    await build.start(startInput());
    await build.alarm();
    expect(storedRow(fixture)).toMatchObject({
      step: 'project_failure',
      last_error: 'provider_configuration_failed',
    });
    expect(mocks.client.createSandbox).not.toHaveBeenCalled();
  });

  it('registers the fenced validator allocation before launching its matching wrapper identity', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'launch_validator_wrapper',
      snapshot_id: 'snapshot-validator',
      validator_session_id: 'validator-session',
    });
    const state = storedRow(fixture);
    if (!state) throw new Error('Expected validator state');
    const createdAt = Date.now() - 1_000;
    mocks.client.getSession.mockResolvedValueOnce({
      session: { status: 'running', requestedAt: createdAt, timeout: 600_000 },
    });
    mocks.control.initializeSnapshotValidator.mockImplementationOnce(async () => {
      expect(storedRow(fixture)).toMatchObject({
        validator_control_id: expect.stringMatching(/^ses-byoc-validator-[a-f0-9]{32}$/),
        validator_wrapper_requested: 0,
      });
      expect(mocks.client.executeCommand).not.toHaveBeenCalled();
    });

    await fixture.build.alarm();

    const providerRef = encodeVercelProviderRef({
      sandboxName: state.validator_name,
      sessionId: 'validator-session',
    });
    const launch = mocks.client.executeCommand.mock.calls[0]?.[1];
    const startup = mocks.downloadedStartup.mock.calls[0]?.[0];
    expect(mocks.downloadedStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: 'a'.repeat(64),
        allocationId: expect.any(String),
        sandboxId: storedRow(fixture)?.validator_control_id,
      })
    );
    expect(launch.sudo).toBe(true);
    expect(launch.args).toContain(
      `download-runtime-and-exec-supervisor\n# byoc-call-home:${startup.allocationId}`
    );
    const identity = verifySandboxLaunchCredential(
      launch.env.SANDBOX_CONTROL_CREDENTIAL,
      'snapshot-test-signing-secret'
    );
    expect(identity?.allocationId).toBe(startup.allocationId);
    expect(identity?.allocationId).not.toBe(FIRST_GENERATION);
    expect(startup.sandboxId).toBe(
      `ses-byoc-validator-${startup.allocationId.replaceAll('-', '')}`
    );
    if (!identity) throw new Error('Expected signed validator identity');
    expect(launch.env.PROVIDER_INSTANCE_ID).toBe(providerRef);
    expect(mocks.control.initializeSnapshotValidator).toHaveBeenCalledWith({
      build: {
        organizationId: ORGANIZATION_ID,
        credentialId: CREDENTIAL_ID,
        generation: FIRST_GENERATION,
        incarnation: startup.allocationId,
      },
      allocation: {
        providerRef,
        locator: {
          teamId: 'team-test',
          projectId: 'project-test',
          snapshotId: 'snapshot-validator',
          runtimeBuildId: state.runtime_build_id,
          runtime: 'node24',
        },
        createdAt,
        expiresAt: createdAt + 600_000,
      },
      credentialHash: await hashSandboxCredential(identity.credential),
    });
    expect(storedRow(fixture)).toMatchObject({
      step: 'verify_validator_call_home',
      validator_wrapper_requested: 1,
      validator_wrapper_command_id: 'command-test',
    });
  });

  it('passes persisted personal ownership to validator initialization', async () => {
    const database = new DatabaseSync(':memory:');
    const storage = createStorage(database);
    const build = createBuild(storage, `user:${PERSONAL_USER_ID}`);
    const input = startInput(FIRST_GENERATION, { userId: PERSONAL_USER_ID });
    await build.start(input);
    updateRow(
      { database, storage, build },
      {
        step: 'launch_validator_wrapper',
        snapshot_id: 'snapshot-validator',
        validator_session_id: 'validator-session',
      },
      `user:${PERSONAL_USER_ID}`
    );

    await build.alarm();

    expect(mocks.control.initializeSnapshotValidator).toHaveBeenCalledWith(
      expect.objectContaining({
        build: {
          userId: PERSONAL_USER_ID,
          credentialId: CREDENTIAL_ID,
          generation: FIRST_GENERATION,
          incarnation: expect.any(String),
        },
      })
    );
  });

  it('waits for the validator allocation to run before registering or launching the wrapper', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'launch_validator_wrapper',
      snapshot_id: 'snapshot-validator',
      validator_session_id: 'validator-session',
    });
    mocks.client.getSession.mockResolvedValueOnce({ session: { status: 'pending' } });

    await fixture.build.alarm();

    expect(storedRow(fixture)).toMatchObject({
      step: 'launch_validator_wrapper',
      validator_wrapper_requested: 0,
    });
    expect(mocks.control.initializeSnapshotValidator).not.toHaveBeenCalled();
    expect(mocks.client.executeCommand).not.toHaveBeenCalled();
    await runNextAlarm(fixture);
    expect(mocks.control.initializeSnapshotValidator).toHaveBeenCalledOnce();
    expect(mocks.client.executeCommand).toHaveBeenCalledOnce();
  });

  it('cleans up a validator whose control failed readiness even while its command still runs', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'verify_validator_call_home',
      snapshot_id: 'snapshot-validator',
      validator_session_id: 'validator-session',
      validator_control_id: 'validator-control',
      validator_wrapper_command_id: 'validator-command',
    });
    mocks.client.getCommand.mockResolvedValueOnce({ exitCode: null });
    mocks.control.getSnapshotValidatorStatus.mockResolvedValueOnce({
      physical: 'failed',
      connection: 'disconnected',
    });

    await fixture.build.alarm();
    expect(storedRow(fixture)).toMatchObject({
      step: 'project_failure',
      last_error: 'validator_call_home_failed',
    });
    await runNextAlarm(fixture);

    expect(mocks.client.getCommand).toHaveBeenCalledOnce();
    expect(mocks.client.stopSession).toHaveBeenCalledOnce();
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-validator');
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('recovers an ambiguous validator launch without rotating its credential or launching twice', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'launch_validator_wrapper',
      snapshot_id: 'snapshot-validator',
      validator_session_id: 'validator-session',
    });
    mocks.client.executeCommand.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'execute-command', 503)
    );
    await fixture.build.alarm();
    mocks.client.listCommands.mockResolvedValueOnce([
      {
        id: 'recovered-command',
        args: [`byoc-call-home:${mocks.downloadedStartup.mock.calls[0]?.[0].allocationId}`],
      },
    ]);

    await runNextAlarm(fixture);

    expect(mocks.control.initializeSnapshotValidator).toHaveBeenCalledOnce();
    expect(mocks.client.executeCommand).toHaveBeenCalledOnce();
    expect(mocks.client.createSandbox).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toMatchObject({
      step: 'verify_validator_call_home',
      validator_wrapper_command_id: 'recovered-command',
    });
  });

  it('retries validator registration before recording a wrapper launch intent', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'launch_validator_wrapper',
      snapshot_id: 'snapshot-validator',
      validator_session_id: 'validator-session',
    });
    mocks.control.initializeSnapshotValidator.mockRejectedValueOnce(
      new mocks.CredentialResolverError('registration unavailable')
    );
    await fixture.build.alarm();

    expect(storedRow(fixture)).toMatchObject({
      step: 'launch_validator_wrapper',
      validator_wrapper_requested: 0,
    });
    expect(mocks.client.executeCommand).not.toHaveBeenCalled();
    await runNextAlarm(fixture);

    expect(mocks.control.initializeSnapshotValidator).toHaveBeenCalledTimes(2);
    expect(mocks.client.executeCommand).toHaveBeenCalledOnce();
    expect(mocks.client.createSandbox).not.toHaveBeenCalled();
  });

  it('deletes the previous Ready snapshot after projecting a replacement', async () => {
    const fixture = createFixture();
    mocks.fetchCredential.mockResolvedValue({
      ...makeCredential(),
      runtimeSnapshotId: 'snapshot-old',
    });
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'confirm_terminal',
      snapshot_id: 'snapshot-ready',
      validator_session_id: 'validator-session',
    });
    mocks.client.getSession.mockResolvedValueOnce({ session: { status: 'stopped' } });

    await fixture.build.alarm();

    expect(mocks.projectStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        setupStatus: 'ready',
        runtimeSnapshotId: 'snapshot-ready',
        runtimeDigest: 'digest-test',
      })
    );
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-old');
    expect(storedRow(fixture)).toBeUndefined();
  });

  it.each([404, 410])(
    'keeps the validated snapshot when terminal inspection returns %s',
    async status => {
      const fixture = createFixture();
      await fixture.build.start(startInput());
      updateRow(fixture, {
        step: 'confirm_terminal',
        snapshot_id: 'snapshot-ready',
        validator_session_id: 'validator-session',
      });
      mocks.client.getSession.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'get-session', status)
      );

      await runNextAlarm(fixture);

      expect(mocks.projectStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ setupStatus: 'ready', runtimeSnapshotId: 'snapshot-ready' })
      );
      expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
      expect(storedRow(fixture)).toBeUndefined();
    }
  );

  it.each([403, 503])(
    'keeps the new ready snapshot if superseded snapshot deletion returns %s',
    async status => {
      const fixture = createFixture();
      mocks.fetchCredential.mockResolvedValue({
        ...makeCredential(),
        runtimeSnapshotId: 'snapshot-old',
      });
      await fixture.build.start(startInput());
      updateRow(fixture, {
        step: 'confirm_terminal',
        snapshot_id: 'snapshot-ready',
        validator_session_id: 'validator-session',
      });
      mocks.client.getSession.mockResolvedValue({ session: { status: 'stopped' } });
      mocks.client.deleteSnapshot.mockRejectedValueOnce(
        new mocks.SandboxRestError('request_failed', 'delete-snapshot', status)
      );

      await runNextAlarm(fixture);

      expect(mocks.projectStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ setupStatus: 'ready', runtimeSnapshotId: 'snapshot-ready' })
      );
      expect(mocks.client.deleteSnapshot.mock.calls).toEqual([['snapshot-old']]);
      expect(storedRow(fixture)).toBeUndefined();
    }
  );

  it('resets projection retries after a full step succeeds', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    mocks.projectStatus.mockRejectedValueOnce(new mocks.CredentialResolverError('unavailable'));
    await runNextAlarm(fixture);
    expect(storedRow(fixture)).toMatchObject({ step: 'validating_access', retry_count: 1 });
    await runNextAlarm(fixture);
    expect(storedRow(fixture)).toMatchObject({ step: 'create_builder', retry_count: 0 });
  });

  it('backs off and exhausts projection retries after successful terminal inspection', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'confirm_terminal',
      snapshot_id: 'snapshot-ready',
      validator_session_id: 'validator-session',
    });
    mocks.client.getSession.mockResolvedValue({ session: { status: 'stopped' } });
    mocks.projectStatus.mockRejectedValue(new mocks.CredentialResolverError('unavailable'));

    for (const [index, delay] of [1_000, 5_000, 15_000, 30_000, 60_000].entries()) {
      const before = Date.now();
      await runNextAlarm(fixture);
      expect(storedRow(fixture)).toMatchObject({
        step: 'confirm_terminal',
        retry_count: index + 1,
      });
      expect(storedRow(fixture)?.next_attempt_at).toBeGreaterThanOrEqual(before + delay);
    }
    await runNextAlarm(fixture);
    expect(storedRow(fixture)).toMatchObject({ step: 'project_failure' });

    mocks.projectStatus.mockResolvedValue(true);
    await runNextAlarm(fixture);
    expect(mocks.projectStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ setupStatus: 'failed' })
    );
    expect(storedRow(fixture)).toBeUndefined();
  });

  it('projects a ready snapshot without deleting it when the validator is terminal', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'confirm_terminal',
      snapshot_id: 'snapshot-ready',
      validator_session_id: 'validator-session',
    });
    mocks.client.getSession.mockResolvedValueOnce({ session: { status: 'stopped' } });

    await fixture.build.alarm();

    expect(mocks.projectStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ setupStatus: 'ready', runtimeSnapshotId: 'snapshot-ready' })
    );
    expect(mocks.client.deleteSnapshot).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });

  it('creates snapshots with an explicit thirty-day expiration in milliseconds', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'snapshot_builder',
      snapshot_source_session_id: 'builder-session',
      snapshot_baseline_json: '[]',
      snapshot_requested: 1,
    });
    mocks.client.createSnapshot.mockResolvedValueOnce({
      id: 'snapshot-finite',
      sourceSessionId: 'builder-session',
      status: 'created',
    });

    await fixture.build.alarm();

    expect(mocks.client.createSnapshot).toHaveBeenCalledWith('builder-session', 2_592_000_000);
    expect(storedRow(fixture)).toMatchObject({
      step: 'create_validator',
      snapshot_id: 'snapshot-finite',
    });
  });

  it('prepares a workspace owned and writable by the sandbox user', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'install_system_dependencies',
      builder_session_id: 'builder-session',
    });

    await fixture.build.alarm();

    const command = mocks.client.executeCommand.mock.calls[0]?.[1];
    expect(command.args[1]).toContain('sudo mkdir -p /workspace');
    expect(command.args[1]).toContain('sudo chown "$(id -u):$(id -g)" /workspace');
    expect(command.args[1]).toContain('test -w /workspace');
  });

  it('installs the base toolchain from pinned bytes and re-checks it by digest', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'install_node_dependencies',
      builder_session_id: 'builder-session',
    });

    await fixture.build.alarm();

    const command = mocks.client.executeCommand.mock.calls[0]?.[1];
    expect(command.args[1]).toContain(RUNTIME_TOOLCHAIN.bun.url);
    expect(command.args[1]).toContain(RUNTIME_TOOLCHAIN.bun.sha256);
    expect(command.args[1]).not.toContain(RUNTIME_TOOLCHAIN.kilo.url);
    expect(command.args[1]).not.toContain(RUNTIME_TOOLCHAIN.kilo.sha256);
    expect(command.args[1]).toContain("check_sha256 '/usr/local/bin/bun'");
    expect(command.args[1]).not.toContain('npm install -g');
    expect(command.args[1]).not.toContain('| bash');
  });

  it('verifies the installed toolchain by digest before the snapshot is created', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'verify_runtime_artifacts',
      builder_session_id: 'builder-session',
    });

    await fixture.build.alarm();

    const command = mocks.client.executeCommand.mock.calls[0]?.[1];
    expect(command.args[1]).toContain(
      `check_sha256 '/usr/local/bin/bun' '${RUNTIME_TOOLCHAIN.bun.installedSha256[0]}'`
    );
    expect(command.args[1]).toContain('sudo npm uninstall -g @kilocode/cli');
    expect(command.args[1]).toContain('test ! -e /usr/local/bin/kilo');
    expect(storedRow(fixture)).toMatchObject({ step: 'snapshot_builder' });
  });

  it('resumes a persisted upload step without baking runtime artifacts into the base snapshot', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'upload_runtime_artifacts',
      builder_session_id: 'builder-session',
    });

    await fixture.build.alarm();

    expect(mocks.client.writeFiles).not.toHaveBeenCalled();
    expect(storedRow(fixture)).toMatchObject({ step: 'verify_runtime_artifacts' });

    await fixture.build.alarm();

    const command = mocks.client.executeCommand.mock.calls[0]?.[1];
    expect(command.args[1]).not.toContain('sudo install');
    expect(command.args[1]).toContain('test ! -e /usr/local/bin/kilocode-control-plane-wrapper.js');
  });
});
