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
import { notifyUserSessionEvent } from '../session-events';
import {
  CLI_DISCONNECT_ATTENTION_RESET_STATUS,
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
