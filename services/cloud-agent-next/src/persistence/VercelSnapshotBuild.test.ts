import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { vercelSnapshotBuilds } from '../db/vercel-snapshot-schema.js';
import { hashSandboxCredential } from '../sandbox-control/credential.js';
import { encodeVercelProviderRef } from '../sandbox-control/vercel-provider.js';

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
      getStatus: vi.fn(),
    },
    fetchCredential: vi.fn(),
    resolveAccess: vi.fn(),
    projectStatus: vi.fn(),
    getArtifacts: vi.fn(),
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

vi.mock('../byoc/vercel-runtime-artifacts.js', () => ({
  getVercelRuntimeArtifacts: mocks.getArtifacts,
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

const { VercelSnapshotBuild } = await import('./VercelSnapshotBuild.js');

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_GENERATION = '33333333-3333-4333-8333-333333333333';
const SECOND_GENERATION = '44444444-4444-4444-8444-444444444444';
const THIRD_GENERATION = '55555555-5555-4555-8555-555555555555';

type BuildRow = typeof vercelSnapshotBuilds.$inferSelect;
type BuildChanges = Partial<typeof vercelSnapshotBuilds.$inferInsert>;
type ManagedSandboxKind = 'builder' | 'validator';

type StorageFixture = ReturnType<typeof createStorage>;
type BuildFixture = {
  database: DatabaseSync;
  storage: StorageFixture;
  build: InstanceType<typeof VercelSnapshotBuild>;
};

function makeCredential(buildGeneration = FIRST_GENERATION) {
  return {
    organizationId: ORGANIZATION_ID,
    credentialId: CREDENTIAL_ID,
    buildGeneration,
    runtimeBuildId: `runtime-${buildGeneration}`,
  };
}

function startInput(buildGeneration = FIRST_GENERATION) {
  return {
    organizationId: ORGANIZATION_ID,
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

function createBuild(storage: StorageFixture): InstanceType<typeof VercelSnapshotBuild> {
  const ctx = {
    id: { name: ORGANIZATION_ID },
    storage,
    blockConcurrencyWhile: vi.fn((action: () => Promise<void>) => action()),
  };
  const env = {
    WORKER_URL: 'https://worker.invalid',
    SANDBOX_CONTROL: { getByName: () => mocks.control },
  };
  return new VercelSnapshotBuild(ctx as never, env as never);
}

function createFixture(): BuildFixture {
  const database = new DatabaseSync(':memory:');
  const storage = createStorage(database);
  return { database, storage, build: createBuild(storage) };
}

function storedRow(fixture: BuildFixture): BuildRow | undefined {
  return drizzle(fixture.storage as never)
    .select()
    .from(vercelSnapshotBuilds)
    .where(eq(vercelSnapshotBuilds.organization_id, ORGANIZATION_ID))
    .get();
}

function updateRow(fixture: BuildFixture, changes: BuildChanges): void {
  drizzle(fixture.storage as never)
    .update(vercelSnapshotBuilds)
    .set(changes)
    .where(eq(vercelSnapshotBuilds.organization_id, ORGANIZATION_ID))
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
  mocks.fetchCredential.mockResolvedValue(makeCredential());
  mocks.resolveAccess.mockResolvedValue({
    accessToken: 'test-vercel-credential',
    teamId: 'team-test',
    projectId: 'project-test',
  });
  mocks.projectStatus.mockResolvedValue(true);
  mocks.control.initializeSnapshotValidator.mockResolvedValue(undefined);
  mocks.control.confirmSnapshotValidatorStopped.mockResolvedValue(undefined);
  mocks.control.getStatus.mockResolvedValue({ physical: 'running', connection: 'ready' });
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
  mocks.getArtifacts.mockResolvedValue([
    {
      path: 'usr/local/bin/kilocode-wrapper.js',
      bytes: new TextEncoder().encode('wrapper'),
      sha256: 'a'.repeat(64),
    },
    {
      path: 'usr/local/bin/kilocode-control-wrapper.js',
      bytes: new TextEncoder().encode('control-wrapper'),
      sha256: 'b'.repeat(64),
    },
  ]);
});

describe('VercelSnapshotBuild persistence isolation', () => {
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
      readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url).pathname, 'utf8')
    ) as {
      entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
    };
    const migrations = Object.fromEntries(
      journal.entries.map(entry => [
        `m${String(entry.idx).padStart(4, '0')}`,
        readFileSync(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url).pathname, 'utf8'),
      ])
    );

    await migrate(drizzle(sessionStorage as never), { journal, migrations });

    const sessionTables = sessionDatabase
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(row => row.name);
    expect(sessionTables).toEqual(
      expect.arrayContaining(['events', 'command_queue', 'execution_leases'])
    );
    expect(sessionTables).not.toContain('vercel_snapshot_builds');
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
      next_attempt_at: null,
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();

    await fixture.build.cleanup(startInput(SECOND_GENERATION));

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
      last_error: 'provider_request_failed',
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
        validator_control_id: `ses-byoc-validator-${FIRST_GENERATION.replaceAll('-', '')}`,
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
    expect(launch.env.PROVIDER_INSTANCE_ID).toBe(providerRef);
    expect(mocks.control.initializeSnapshotValidator).toHaveBeenCalledWith({
      build: {
        organizationId: ORGANIZATION_ID,
        credentialId: CREDENTIAL_ID,
        generation: FIRST_GENERATION,
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
      credentialHash: await hashSandboxCredential(launch.env.SANDBOX_CONTROL_CREDENTIAL),
    });
    expect(storedRow(fixture)).toMatchObject({
      step: 'verify_validator_call_home',
      validator_wrapper_requested: 1,
      validator_wrapper_command_id: 'command-test',
    });
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
    mocks.control.getStatus.mockResolvedValueOnce({
      physical: 'failed',
      connection: 'disconnected',
    });

    await fixture.build.alarm();
    expect(storedRow(fixture)?.step).toBe('project_failure');
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
      { id: 'recovered-command', args: [`byoc-call-home:${FIRST_GENERATION}`] },
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

  it('stages runtime artifacts in tmp and installs validated root-owned files with sudo', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, {
      step: 'upload_runtime_artifacts',
      builder_session_id: 'builder-session',
    });

    await fixture.build.alarm();

    expect(mocks.client.writeFiles).toHaveBeenCalledWith('builder-session', '/tmp', [
      expect.objectContaining({ path: 'kilocode-wrapper.js' }),
      expect.objectContaining({ path: 'kilocode-control-wrapper.js' }),
      expect.objectContaining({ path: 'kilo-runtime-manifest.json' }),
    ]);
    const manifest = JSON.parse(mocks.client.writeFiles.mock.calls[0]?.[2]?.[2]?.content);
    expect(manifest.wrapperSha256).toBe('a'.repeat(64));

    await fixture.build.alarm();

    const command = mocks.client.executeCommand.mock.calls[0]?.[1];
    expect(command.args[1]).toContain(
      'sudo install -m 0755 /tmp/kilocode-wrapper.js /usr/local/bin/kilocode-wrapper.js'
    );
    expect(command.args[1]).toContain(
      'sudo install -m 0755 /tmp/kilocode-control-wrapper.js /usr/local/bin/kilocode-control-wrapper.js'
    );
    expect(command.args[1]).toContain(
      'sudo install -m 0644 /tmp/kilo-runtime-manifest.json /usr/local/share/kilo/runtime-manifest.json'
    );
    expect(command.args[1]).toContain('sha256sum /usr/local/bin/kilocode-wrapper.js');
  });
});
