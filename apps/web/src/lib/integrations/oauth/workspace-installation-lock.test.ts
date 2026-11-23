const mockTransaction = jest.fn();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    // Accessed lazily: jest.mock factories hoist above the const declarations.
    get transaction() {
      return mockTransaction;
    },
  },
}));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Owner } from '@/lib/integrations/core/types';
import {
  INSTALLATION_LOCK_WAIT_MS,
  INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS,
  INSTALLATION_WRITE_STATEMENT_TIMEOUT_MS,
  withInstallationServerLock,
  withWorkspaceInstallationLock,
} from '@/lib/integrations/oauth/workspace-installation-lock';

const owner = { type: 'user', id: 'user-1' } satisfies Owner;
const installationId = 'installation-1';
const dialect = new PgDialect();

/**
 * Statements the locked section executed, in order: the SQL Postgres receives
 * and the values bound to its placeholders. Advisory-lock keys are bound, so a
 * statement is identified by both.
 */
let executed: { sql: string; params: unknown[] }[] = [];

describe('workspace installation lock statement budget', () => {
  beforeEach(() => {
    executed = [];
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async (statement: unknown) => {
          executed.push(dialect.sqlToQuery(statement as SQL));
        },
      })
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['a fractional count', 1.5],
    ['zero', 0],
    ['a negative count', -1000],
    ['a count above the safe integer range', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s before the section opens', async (_label, budget) => {
    await expect(
      withWorkspaceInstallationLock('discord', owner, installationId, async () => 'done', {
        statementTimeoutMs: budget,
      })
    ).rejects.toThrow(
      new RangeError('A statement budget must be a whole number of milliseconds, at least 1')
    );

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });

  it('renders a custom budget after both advisory locks', async () => {
    await expect(
      withWorkspaceInstallationLock('discord', owner, installationId, async () => 'done', {
        statementTimeoutMs: 1500,
      })
    ).resolves.toBe('done');

    const budget = executed.findIndex(
      ({ sql }) => sql === "SET LOCAL statement_timeout = '1500ms'"
    );
    const ownerLock = executed.findIndex(
      ({ sql, params }) =>
        sql.includes('pg_advisory_xact_lock') &&
        params.some(param => String(param).includes('integration-installation-owner'))
    );
    const serverLock = executed.findIndex(
      ({ sql, params }) =>
        sql.includes('pg_advisory_xact_lock') &&
        !params.some(param => String(param).includes('integration-installation-owner'))
    );

    expect(ownerLock).toBeGreaterThanOrEqual(0);
    expect(serverLock).toBeGreaterThan(ownerLock);
    expect(budget).toBeGreaterThan(serverLock);
  });

  it('renders both sections from the shared budget and lock wait constants', async () => {
    await withInstallationServerLock('discord', installationId, async () => 'done');
    const serverSection = executed.map(({ sql }) => sql);
    executed = [];

    await withWorkspaceInstallationLock('discord', owner, installationId, async () => 'done');
    const workspaceSection = executed.map(({ sql }) => sql);

    expect(serverSection).toEqual([
      `SET LOCAL lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `SET LOCAL statement_timeout = '${INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS}ms'`,
    ]);

    expect(workspaceSection).toEqual([
      `SET LOCAL lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `SET LOCAL statement_timeout = '${INSTALLATION_WRITE_STATEMENT_TIMEOUT_MS}ms'`,
    ]);
  });
});
