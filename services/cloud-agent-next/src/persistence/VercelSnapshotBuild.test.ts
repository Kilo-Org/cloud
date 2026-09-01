import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { vercelSnapshotBuilds } from '../db/vercel-snapshot-schema.js';

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

function createFixture(): BuildFixture {
  const database = new DatabaseSync(':memory:');
  const storage = createStorage(database);
  const ctx = {
    id: { name: ORGANIZATION_ID },
    storage,
    blockConcurrencyWhile: vi.fn((action: () => Promise<void>) => action()),
  };
  const env = { WORKER_URL: 'https://worker.invalid' };
  const build = new VercelSnapshotBuild(ctx as never, env as never);

  return { database, storage, build };
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
  mocks.client.inspectTeam.mockResolvedValue({ id: 'team-test', slug: 'team-test' });
  mocks.client.inspectProject.mockResolvedValue({ id: 'project-test', name: 'project-test' });
  mocks.client.inspectByName.mockResolvedValue(null);
  mocks.client.listSnapshots.mockResolvedValue([]);
  mocks.client.stopSession.mockResolvedValue({ status: 'stopped' });
  mocks.client.deleteSnapshot.mockResolvedValue(undefined);
  mocks.client.writeFiles.mockResolvedValue(undefined);
  mocks.client.executeCommand.mockResolvedValue({
    command: { id: 'command-test', exitCode: null },
    finished: { id: 'command-test', exitCode: 0 },
  });
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

  it('retains failed builder ownership when provider stop cannot be confirmed', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { builder_session_id: 'builder-failed' });
    mocks.client.inspectTeam.mockRejectedValueOnce(new Error('deterministic-failure'));
    mocks.client.stopSession.mockRejectedValueOnce(
      new mocks.SandboxRestError('request_failed', 'stop-session', 503)
    );

    await expect(fixture.build.alarm()).rejects.toMatchObject({
      operation: 'stop-session',
      status: 503,
    });

    expect(storedRow(fixture)).toMatchObject({
      builder_session_id: 'builder-failed',
      next_attempt_at: null,
    });
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled();

    await fixture.build.cleanup(startInput());

    expect(storedRow(fixture)).toBeUndefined();
  });

  it('deletes failed snapshots while their credential remains available', async () => {
    const fixture = createFixture();
    await fixture.build.start(startInput());
    updateRow(fixture, { snapshot_id: 'snapshot-failed' });
    mocks.client.inspectTeam.mockRejectedValueOnce(new Error('deterministic-failure'));

    await fixture.build.alarm();

    expect(mocks.projectStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ setupStatus: 'failed', runtimeSnapshotId: null })
    );
    expect(mocks.client.deleteSnapshot).toHaveBeenCalledWith('snapshot-failed');
    expect(storedRow(fixture)).toBeUndefined();
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledOnce();
  });
});

describe('VercelSnapshotBuild runtime preparation', () => {
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
