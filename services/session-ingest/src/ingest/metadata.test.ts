import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('../dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(),
}));

vi.mock('../session-events', () => ({
  mapSessionEventRow: vi.fn((row: { session_id: string; status: string | null }) => ({
    source: 'v2' as const,
    sessionId: row.session_id,
    status: row.status,
    statusUpdatedAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  })),
  notifyUserSessionEvent: vi.fn(),
}));

import { getWorkerDb } from '@kilocode/db/client';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { notifyUserSessionEvent } from '../session-events';
import {
  applyMetadataChanges,
  CLI_DISCONNECT_ATTENTION_RESET_STATUS,
  computeSessionMetadataUpdates,
  resetAttentionStatusOnCliDisconnect,
} from './metadata';

type StatusRow = { status: string | null };

function createTransactionDb(options: {
  initialStatus: string | null;
  /** After the conditional update, status read-back (simulates concurrent overwrite). */
  persistedStatus?: string | null;
  rowMissing?: boolean;
}) {
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  // Named without the substring "update" so oxlint drizzle rules do not flag test spies.
  const applyUpdate = vi.fn(() => ({ set: updateSet }));

  let selectCall = 0;

  function rowsForSelect(): unknown[] {
    selectCall += 1;
    if (options.rowMissing) return [];
    if (selectCall === 1) {
      return [{ status: options.initialStatus } satisfies StatusRow];
    }
    const status =
      options.persistedStatus !== undefined
        ? options.persistedStatus
        : options.initialStatus !== null &&
            (options.initialStatus === 'question' || options.initialStatus === 'permission')
          ? CLI_DISCONNECT_ATTENTION_RESET_STATUS
          : options.initialStatus;
    return [
      {
        session_id: 'ses_1',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:01.000Z',
        title: 'T',
        created_on_platform: 'cli',
        organization_id: null,
        git_url: null,
        git_branch: null,
        parent_session_id: null,
        status,
        status_updated_at: '2026-07-25T00:00:00.000Z',
      },
    ];
  }

  /** Thenable that also supports `.for('update')` (first select locks; second does not). */
  function limitResult() {
    const promise = Promise.resolve(rowsForSelect());
    return Object.assign(promise, {
      for: vi.fn(() => promise),
    });
  }

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => limitResult()),
      })),
    })),
  }));

  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ select, update: applyUpdate })
  );

  return { transaction, select, applyUpdate, updateSet, updateWhere };
}

type ApplyMetadataDbOptions = {
  /** Membership join row count (0 = unauthorized / missing / soft-deleted). */
  membershipRows?: number;
  /** When set, the next non-lock session select is treated as a parent lookup. */
  parentExists?: boolean;
  initialStatus?: string | null;
  rowMissing?: boolean;
  cloudAgentSessionScopeId?: string | null;
  cloudAgentSessionId?: string | null;
  parentSessionId?: string | null;
  createsCycle?: boolean;
  scopeRootMissing?: boolean;
  /** Title stored on the row before applyMetadataChanges runs. Defaults to the creation placeholder (NULL). */
  initialTitle?: string | null;
  /** git_url stored on the row before applyMetadataChanges runs. Defaults to NULL. */
  initialGitUrl?: string | null;
};

/**
 * Fluent drizzle double for applyMetadataChanges.
 *
 * Distinguishes query kinds by chain shape:
 * - membership (hasOrganizationAccess): select → from → innerJoin → where → limit
 * - status lock: select → from → where → limit → for('update')
 * - parent / read-back: select → from → where → limit (awaited without for)
 */
function createApplyMetadataDb(options: ApplyMetadataDbOptions = {}) {
  const updateSets: unknown[] = [];
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn((values: unknown) => {
    updateSets.push(values);
    return { where: updateWhere };
  });
  // Named without the substring "update" so oxlint drizzle rules do not flag test spies.
  const applyUpdate = vi.fn(() => ({ set: updateSet }));

  const queryLog: Array<
    'session-initial' | 'session-lock' | 'membership' | 'parent' | 'read-back'
  > = [];
  let initialReadDone = false;
  let parentLookupDone = false;
  let lockCount = 0;

  function currentSessionState() {
    return {
      title: options.initialTitle ?? null,
      status: options.initialStatus ?? 'idle',
      parentSessionId: options.parentSessionId ?? null,
      cloudAgentSessionScopeId: options.cloudAgentSessionScopeId ?? null,
      cloudAgentSessionId: options.cloudAgentSessionId ?? null,
      gitUrl: options.initialGitUrl ?? null,
    };
  }

  function persistedSessionRow() {
    return {
      session_id: 'ses_1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
      title: 'T',
      created_on_platform: 'cli',
      organization_id: null,
      git_url: options.initialGitUrl ?? null,
      git_branch: null,
      parent_session_id: null,
      status: options.initialStatus ?? 'idle',
      status_updated_at: '2026-07-25T00:00:00.000Z',
    };
  }

  function sessionLimitResult() {
    // Dual-mode: `.for('update')` ⇒ status lock; bare await ⇒ parent lookup or read-back.
    let settled: Promise<unknown[]> | undefined;

    const resolveWithoutFor = () => {
      if (!initialReadDone) {
        initialReadDone = true;
        queryLog.push('session-initial');
        return options.rowMissing ? [] : [currentSessionState()];
      }
      if (options.parentExists !== undefined && !parentLookupDone) {
        parentLookupDone = true;
        queryLog.push('parent');
        return options.parentExists ? [{ sessionId: 'ses_parent' }] : [];
      }
      queryLog.push('read-back');
      return options.rowMissing ? [] : [persistedSessionRow()];
    };

    const thenable = {
      for: vi.fn(() => {
        lockCount += 1;
        initialReadDone = true;
        queryLog.push('session-lock');
        const rows =
          options.rowMissing || (options.scopeRootMissing && lockCount === 1)
            ? []
            : [currentSessionState()];
        settled = Promise.resolve(rows);
        return settled;
      }),
      then(onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) {
        settled ??= Promise.resolve(resolveWithoutFor());
        return settled.then(onFulfilled, onRejected);
      },
    };
    return thenable;
  }

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            queryLog.push('membership');
            const count = options.membershipRows ?? 0;
            return count > 0 ? [{ id: 'mem_1' }] : [];
          }),
        })),
      })),
      where: vi.fn(() => ({
        limit: vi.fn(() => sessionLimitResult()),
      })),
    })),
  }));

  const execute = vi.fn(async () => ({
    rows: [{ creates_cycle: options.createsCycle ?? false }],
  }));
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ select, update: applyUpdate, execute })
  );

  return {
    transaction,
    select,
    applyUpdate,
    updateSet,
    updateWhere,
    updateSets,
    execute,
    queryLog,
    membershipQueryCount: () => queryLog.filter(k => k === 'membership').length,
  };
}

describe('resetAttentionStatusOnCliDisconnect', () => {
  beforeEach(() => {
    vi.mocked(getWorkerDb).mockReset();
    vi.mocked(notifyUserSessionEvent).mockReset();
  });

  it('writes retry and notifies when stored status is question', async () => {
    const db = createTransactionDb({ initialStatus: 'question' });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const env = { HYPERDRIVE: { connectionString: 'postgres://unused' } } as never;
    await resetAttentionStatusOnCliDisconnect(env, 'usr_1', 'ses_1');

    expect(db.applyUpdate).toHaveBeenCalled();
    expect(db.updateSet).toHaveBeenCalledWith({
      status: CLI_DISCONNECT_ATTENTION_RESET_STATUS,
      status_updated_at: expect.any(String),
    });
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      'usr_1',
      expect.objectContaining({
        type: 'session.status.updated',
        data: expect.objectContaining({
          previousStatus: 'question',
          status: CLI_DISCONNECT_ATTENTION_RESET_STATUS,
        }),
      }),
      undefined
    );
  });

  it('writes retry and notifies when stored status is permission', async () => {
    const db = createTransactionDb({ initialStatus: 'permission' });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const env = { HYPERDRIVE: { connectionString: 'postgres://unused' } } as never;
    await resetAttentionStatusOnCliDisconnect(env, 'usr_1', 'ses_1');

    expect(db.applyUpdate).toHaveBeenCalled();
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      'usr_1',
      expect.objectContaining({
        type: 'session.status.updated',
        data: expect.objectContaining({
          previousStatus: 'permission',
          status: CLI_DISCONNECT_ATTENTION_RESET_STATUS,
        }),
      }),
      undefined
    );
  });

  it.each(['busy', 'idle', 'retry', null] as const)(
    'no-ops without write or notify when stored status is %s',
    async status => {
      const db = createTransactionDb({ initialStatus: status });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await resetAttentionStatusOnCliDisconnect(
        { HYPERDRIVE: { connectionString: 'postgres://unused' } } as never,
        'usr_1',
        'ses_1'
      );

      expect(db.applyUpdate).not.toHaveBeenCalled();
      expect(notifyUserSessionEvent).not.toHaveBeenCalled();
    }
  );

  it('no-ops when the session row is missing', async () => {
    const db = createTransactionDb({ initialStatus: 'question', rowMissing: true });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await resetAttentionStatusOnCliDisconnect(
      { HYPERDRIVE: { connectionString: 'postgres://unused' } } as never,
      'usr_1',
      'ses_missing'
    );

    expect(db.applyUpdate).not.toHaveBeenCalled();
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });

  it('does not notify when a concurrent write wins the conditional update', async () => {
    const db = createTransactionDb({
      initialStatus: 'question',
      // Conditional WHERE matched nothing; row still shows busy after the race.
      persistedStatus: 'busy',
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await resetAttentionStatusOnCliDisconnect(
      { HYPERDRIVE: { connectionString: 'postgres://unused' } } as never,
      'usr_1',
      'ses_1'
    );

    expect(db.applyUpdate).toHaveBeenCalled();
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });
});

describe('applyMetadataChanges', () => {
  const env = { HYPERDRIVE: { connectionString: 'postgres://unused' } } as never;
  const cacheRemove = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.mocked(getWorkerDb).mockReset();
    vi.mocked(notifyUserSessionEvent).mockReset();
    vi.mocked(getSessionAccessCacheDO).mockReset();
    cacheRemove.mockReset();
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({
      remove: cacheRemove,
    } as never);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('persists organization_id and invalidates access cache when the user is a member', async () => {
    const db = createApplyMetadataDb({ membershipRows: 1 });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['orgId', 'org_live'],
        ['title', 'Hello'],
      ])
    );

    expect(db.membershipQueryCount()).toBe(1);
    expect(db.updateSets).toEqual([
      expect.objectContaining({
        organization_id: 'org_live',
        title: 'Hello',
      }),
    ]);
    expect(getSessionAccessCacheDO).toHaveBeenCalledWith(env, { kiloUserId: 'usr_1' });
    expect(cacheRemove).toHaveBeenCalledWith('ses_1');
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      'usr_1',
      expect.objectContaining({ type: 'session.updated' }),
      undefined
    );
  });

  it('refuses unauthorized organization_id while persisting the rest of the batch', async () => {
    const db = createApplyMetadataDb({ membershipRows: 0 });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const warnSpy = vi.mocked(console.warn);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['orgId', 'org_foreign'],
        ['title', 'Kept title'],
        ['gitUrl', 'https://github.com/acme/repo.git'],
        ['status', 'busy'],
      ])
    );

    expect(db.membershipQueryCount()).toBe(1);
    expect(db.updateSets).toHaveLength(1);
    const written = db.updateSets[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('organization_id');
    expect(written.title).toBe('Kept title');
    expect(written.git_url).toBe('https://github.com/acme/repo');
    expect(written.status).toBe('busy');
    expect(written.status_updated_at).toEqual(expect.any(String));
    expect(warnSpy).toHaveBeenCalledWith(
      'Refusing unauthorized organization_id metadata write',
      expect.objectContaining({
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        organizationId: 'org_foreign',
      })
    );
  });

  it('does not treat a refused orgId-only batch as a scope change or session.updated', async () => {
    const db = createApplyMetadataDb({ membershipRows: 0 });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['orgId', 'org_foreign']]));

    // Refused field is stripped; empty updates object skips the UPDATE entirely.
    expect(db.applyUpdate).not.toHaveBeenCalled();
    expect(db.updateSets).toEqual([]);
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
    expect(cacheRemove).not.toHaveBeenCalled();
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });

  it('still emits session.updated when a refused orgId is paired with parentId', async () => {
    const db = createApplyMetadataDb({ membershipRows: 0, parentExists: true });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['orgId', 'org_foreign'],
        ['parentId', 'ses_parent'],
      ])
    );

    expect(db.updateSets).toEqual([expect.objectContaining({ parent_session_id: 'ses_parent' })]);
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      'usr_1',
      expect.objectContaining({ type: 'session.updated' }),
      undefined
    );
  });

  it('refuses organization_id for a soft-deleted org while persisting the rest', async () => {
    // Soft-deleted orgs yield no membership join row (deleted_at IS NULL filter).
    const db = createApplyMetadataDb({ membershipRows: 0 });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const warnSpy = vi.mocked(console.warn);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['orgId', 'org_deleted'],
        ['title', 'Still written'],
        ['status', 'idle'],
      ])
    );

    const written = db.updateSets[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('organization_id');
    expect(written.title).toBe('Still written');
    expect(written.status).toBe('idle');
    expect(warnSpy).toHaveBeenCalledWith(
      'Refusing unauthorized organization_id metadata write',
      expect.objectContaining({ organizationId: 'org_deleted' })
    );
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
  });

  it('performs zero membership queries when orgId is absent', async () => {
    const db = createApplyMetadataDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['title', 'No org'],
        ['platform', 'cli'],
        ['status', 'busy'],
      ])
    );

    expect(db.membershipQueryCount()).toBe(0);
    expect(db.updateSets).toEqual([
      expect.objectContaining({
        title: 'No org',
        created_on_platform: 'cli',
        status: 'busy',
      }),
    ]);
    const written = db.updateSets[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('organization_id');
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
  });

  it('clears organization_id on explicit null without a membership query', async () => {
    const db = createApplyMetadataDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['orgId', null]]));

    expect(db.membershipQueryCount()).toBe(0);
    expect(db.updateSets).toEqual([expect.objectContaining({ organization_id: null })]);
    expect(getSessionAccessCacheDO).toHaveBeenCalledWith(env, { kiloUserId: 'usr_1' });
    expect(cacheRemove).toHaveBeenCalledWith('ses_1');
  });

  it('refuses a nonexistent org claim without aborting the rest of the batch', async () => {
    // Nonexistent org looks like no membership row to the check; never reaches FK.
    const db = createApplyMetadataDb({ membershipRows: 0 });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['orgId', '00000000-0000-4000-8000-000000000099'],
        ['title', 'Survives'],
        ['platform', 'cli'],
        ['status', 'busy'],
      ])
    );

    const written = db.updateSets[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('organization_id');
    expect(written.title).toBe('Survives');
    expect(written.created_on_platform).toBe('cli');
    expect(written.status).toBe('busy');
    expect(db.applyUpdate).toHaveBeenCalled();
  });

  it('refuses organization metadata changes for Cloud Agent session-scoped sessions', async () => {
    const db = createApplyMetadataDb({
      cloudAgentSessionScopeId: 'cloud-agent-session-scope-1',
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['orgId', '11111111-1111-4111-8111-111111111111'],
        ['title', 'Still allowed'],
      ])
    );

    expect(db.membershipQueryCount()).toBe(0);
    expect(db.updateSets).toEqual([expect.objectContaining({ title: 'Still allowed' })]);
    expect(db.updateSets[0]).not.toHaveProperty('organization_id');
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
  });

  it('refuses organization metadata changes for uncontained Cloud Agent roots', async () => {
    const db = createApplyMetadataDb({
      cloudAgentSessionScopeId: null,
      cloudAgentSessionId: 'cloud-agent-session-1',
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['orgId', '11111111-1111-4111-8111-111111111111'],
        ['title', 'Still allowed'],
      ])
    );

    expect(db.membershipQueryCount()).toBe(0);
    expect(db.updateSets).toEqual([expect.objectContaining({ title: 'Still allowed' })]);
    expect(db.updateSets[0]).not.toHaveProperty('organization_id');
  });

  it('refuses to reparent a Cloud Agent root', async () => {
    const db = createApplyMetadataDb({
      cloudAgentSessionScopeId: 'cloud-agent-session-scope-1',
      cloudAgentSessionId: 'cloud-agent-session-scope-1',
      parentExists: true,
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['parentId', 'ses_parent']]));

    expect(db.updateSets).toEqual([]);
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });

  it('refuses to reparent a legacy Cloud Agent root before session scope healing', async () => {
    const db = createApplyMetadataDb({
      cloudAgentSessionScopeId: null,
      cloudAgentSessionId: 'cloud-agent-session-scope-1',
      parentExists: true,
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['parentId', 'ses_parent']]));

    expect(db.updateSets).toEqual([]);
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });

  it('allows a cycle-free child reparent within the same session scope', async () => {
    const db = createApplyMetadataDb({
      cloudAgentSessionScopeId: 'cloud-agent-session-scope-1',
      parentSessionId: 'ses_root',
      parentExists: true,
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['parentId', 'ses_parent']]));

    expect(db.queryLog.filter(entry => entry === 'session-lock')).toHaveLength(2);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.updateSets).toContainEqual({ parent_session_id: 'ses_parent' });
  });

  it('refuses a same-scope reparent that would create a cycle', async () => {
    const db = createApplyMetadataDb({
      cloudAgentSessionScopeId: 'cloud-agent-session-scope-1',
      parentSessionId: 'ses_root',
      parentExists: true,
      createsCycle: true,
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['parentId', 'ses_parent']]));

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.updateSets).toEqual([]);
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
  });

  describe('agent-generated title vs. user rename race', () => {
    it('applies the agent-generated title when the row still has the creation placeholder (NULL)', async () => {
      const db = createApplyMetadataDb({ initialTitle: null });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['title', 'Agent title']]));

      expect(db.updateSets).toEqual([expect.objectContaining({ title: 'Agent title' })]);
      expect(notifyUserSessionEvent).toHaveBeenCalledWith(
        env,
        'usr_1',
        expect.objectContaining({ type: 'session.updated' }),
        undefined
      );
    });

    it('applies the agent-generated title over the default title stamped at creation (cloud-agent-next)', async () => {
      // cloud-agent-next creates rows with a non-null default title
      // (`New session - <ISO timestamp>`) via createSessionForCloudAgent; that title is
      // still the creation placeholder and must not block the agent-generated title.
      const db = createApplyMetadataDb({ initialTitle: 'New session - 2026-08-04T10:00:00.000Z' });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['title', 'Agent title']]));

      expect(db.updateSets).toEqual([expect.objectContaining({ title: 'Agent title' })]);
      expect(notifyUserSessionEvent).toHaveBeenCalledWith(
        env,
        'usr_1',
        expect.objectContaining({ type: 'session.updated' }),
        undefined
      );
    });

    it('skips the agent-generated title write when the user already renamed the session', async () => {
      const db = createApplyMetadataDb({ initialTitle: 'User chosen title' });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);
      const warnSpy = vi.mocked(console.warn);

      await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['title', 'Agent title']]));

      // Title write is dropped entirely; no update statement is issued for a title-only batch.
      expect(db.applyUpdate).not.toHaveBeenCalled();
      expect(db.updateSets).toEqual([]);
      expect(notifyUserSessionEvent).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Skipping agent-generated title write; title is no longer the placeholder',
        expect.objectContaining({ kiloUserId: 'usr_1', sessionId: 'ses_1' })
      );
    });

    it('still applies other metadata fields when the title write is skipped due to a prior user rename', async () => {
      const db = createApplyMetadataDb({ initialTitle: 'User chosen title' });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(
        env,
        'usr_1',
        'ses_1',
        new Map([
          ['title', 'Agent title'],
          ['platform', 'cli'],
          ['status', 'busy'],
        ])
      );

      expect(db.updateSets).toEqual([
        expect.objectContaining({
          created_on_platform: 'cli',
          status: 'busy',
        }),
      ]);
      const written = db.updateSets[0] as Record<string, unknown>;
      expect(written).not.toHaveProperty('title');
    });
  });

  it('logs when a session scope root is missing during reparent', async () => {
    const db = createApplyMetadataDb({
      cloudAgentSessionScopeId: 'cloud-agent-session-scope-1',
      parentSessionId: 'ses_root',
      parentExists: true,
      scopeRootMissing: true,
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['parentId', 'ses_parent']]));

    expect(console.warn).toHaveBeenCalledWith(
      'Refusing Cloud Agent reparent without a session scope root',
      expect.objectContaining({
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        cloudAgentSessionScopeId: 'cloud-agent-session-scope-1',
      })
    );
    expect(db.updateSets).toEqual([]);
  });

  it('persists the PR-link triple and emits session.updated', async () => {
    const db = createApplyMetadataDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['prPlatform', 'github'],
        ['prUrl', 'https://github.com/acme/widgets/pull/42'],
        ['prNumber', '42'],
      ])
    );

    expect(db.updateSets).toEqual([
      expect.objectContaining({
        platform: 'github',
        pr_url: 'https://github.com/acme/widgets/pull/42',
        pr_number: 42,
      }),
    ]);
    const written = db.updateSets[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('created_on_platform');
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      'usr_1',
      expect.objectContaining({ type: 'session.updated' }),
      undefined
    );
  });

  it('clears the PR-link triple and emits session.updated', async () => {
    const db = createApplyMetadataDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    await applyMetadataChanges(
      env,
      'usr_1',
      'ses_1',
      new Map([
        ['prPlatform', null],
        ['prUrl', null],
        ['prNumber', null],
      ])
    );

    expect(db.updateSets).toEqual([
      expect.objectContaining({
        platform: null,
        pr_url: null,
        pr_number: null,
      }),
    ]);
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      'usr_1',
      expect.objectContaining({ type: 'session.updated' }),
      undefined
    );
  });

  describe('Cloud Agent git_url immutability', () => {
    it('heals a null Cloud Agent git_url to the normalized input', async () => {
      const db = createApplyMetadataDb({
        cloudAgentSessionId: 'cloud-agent-session-1',
        initialGitUrl: null,
      });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(
        env,
        'usr_1',
        'ses_1',
        new Map([['gitUrl', 'https://github.com/acme/repo.git']])
      );

      expect(db.updateSets).toEqual([
        expect.objectContaining({ git_url: 'https://github.com/acme/repo' }),
      ]);
      expect(notifyUserSessionEvent).toHaveBeenCalledWith(
        env,
        'usr_1',
        expect.objectContaining({ type: 'session.updated' }),
        undefined
      );
    });

    it('ignores an identical Cloud Agent git_url rewrite', async () => {
      const db = createApplyMetadataDb({
        cloudAgentSessionId: 'cloud-agent-session-1',
        initialGitUrl: 'https://github.com/acme/repo',
      });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(
        env,
        'usr_1',
        'ses_1',
        new Map([['gitUrl', 'https://github.com/acme/repo.git']])
      );

      expect(db.updateSets).toEqual([]);
      expect(db.applyUpdate).not.toHaveBeenCalled();
      expect(notifyUserSessionEvent).not.toHaveBeenCalled();
    });

    it('rejects a clear of an existing Cloud Agent git_url', async () => {
      const db = createApplyMetadataDb({
        cloudAgentSessionId: 'cloud-agent-session-1',
        initialGitUrl: 'https://github.com/acme/repo',
      });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(env, 'usr_1', 'ses_1', new Map([['gitUrl', null]]));

      expect(db.updateSets).toEqual([]);
      expect(notifyUserSessionEvent).not.toHaveBeenCalled();
    });

    it('rejects a different Cloud Agent git_url', async () => {
      const db = createApplyMetadataDb({
        cloudAgentSessionId: 'cloud-agent-session-1',
        initialGitUrl: 'https://github.com/acme/repo',
      });
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(
        env,
        'usr_1',
        'ses_1',
        new Map([['gitUrl', 'https://github.com/other/repo']])
      );

      expect(db.updateSets).toEqual([]);
      expect(notifyUserSessionEvent).not.toHaveBeenCalled();
    });

    it('keeps non-Cloud-Agent git_url writes unchanged', async () => {
      const db = createApplyMetadataDb();
      vi.mocked(getWorkerDb).mockReturnValue(db as never);

      await applyMetadataChanges(
        env,
        'usr_1',
        'ses_1',
        new Map([['gitUrl', 'https://github.com/acme/repo.git']])
      );

      expect(db.updateSets).toEqual([
        expect.objectContaining({ git_url: 'https://github.com/acme/repo' }),
      ]);
      expect(notifyUserSessionEvent).toHaveBeenCalledWith(
        env,
        'usr_1',
        expect.objectContaining({ type: 'session.updated' }),
        undefined
      );
    });
  });
});

describe('computeSessionMetadataUpdates PR link', () => {
  const fixedNow = () => '2026-05-05T00:00:00.000Z';

  it('maps the triple to platform/pr_url/pr_number with Number conversion', () => {
    const updates = computeSessionMetadataUpdates(
      new Map([
        ['prPlatform', 'github'],
        ['prUrl', 'https://github.com/acme/widgets/pull/42'],
        ['prNumber', '42'],
      ]),
      fixedNow
    );
    expect(updates.platform).toBe('github');
    expect(updates.pr_url).toBe('https://github.com/acme/widgets/pull/42');
    expect(updates.pr_number).toBe(42);
  });

  it('clears all three columns on a clear triple', () => {
    const updates = computeSessionMetadataUpdates(
      new Map([
        ['prPlatform', null],
        ['prUrl', null],
        ['prNumber', null],
      ]),
      fixedNow
    );
    expect(updates.platform).toBeNull();
    expect(updates.pr_url).toBeNull();
    expect(updates.pr_number).toBeNull();
  });

  it('does not write the PR-link columns when the change is absent', () => {
    const updates = computeSessionMetadataUpdates(new Map([['title', 'hello']]), fixedNow);
    expect('platform' in updates).toBe(false);
    expect('pr_url' in updates).toBe(false);
    expect('pr_number' in updates).toBe(false);
  });

  it('does not touch created_on_platform from prPlatform', () => {
    const updates = computeSessionMetadataUpdates(new Map([['prPlatform', 'github']]), fixedNow);
    expect(updates.platform).toBe('github');
    expect('created_on_platform' in updates).toBe(false);
  });
});
