import { randomUUID } from 'node:crypto';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IdentityStore } from '../../src/db/client';
import { type CiExchangeInput, type CiTokenStore, identityStoreCiTokens } from '../../src/ci/store';
import { type SubjectStore, identityStoreSubjects } from '../../src/subjects/store';
import { TestDatabase, insertAccount, sqlStateOf } from './harness';

/**
 * The CI exchange's statement (migration 0023, `uts.exchange_ci_token`) through the Worker's own
 * store (`src/ci/store.ts`), run as the app login: the issued and denied audit rows.
 */

let db: TestDatabase;
let owner: pg.Client;
let store: CiTokenStore;
let subjects: SubjectStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  const app = new IdentityStore(await db.connect('uts_app_a'));
  store = identityStoreCiTokens(app);
  subjects = identityStoreSubjects(app);
});
afterAll(() => db.drop());

const AuditRowSchema = z.object({ event_type: z.string(), event: z.unknown() });

async function auditRows(accountId: string) {
  const result = await owner.query(
    'SELECT event_type, event FROM uts.audit_events WHERE account_id = $1 ORDER BY id',
    [accountId]
  );
  return result.rows.map(row => {
    const parsed = AuditRowSchema.parse(row);
    return { type: parsed.event_type, event: AuditEventSchema.parse(parsed.event) };
  });
}

function input(accountId: string, overrides: Partial<CiExchangeInput> = {}): CiExchangeInput {
  return {
    environment: 'development',
    policy: 'ci-example-smoke',
    accountId,
    scope: 'kilo-gateway:inference',
    lifetimeSeconds: 3600,
    refusal: null,
    run: {
      repositoryId: '111111',
      githubEnvironment: 'smoke',
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      eventName: 'workflow_dispatch',
      jobWorkflowRef: 'Example-Org/example/.github/workflows/smoke.yml@refs/heads/main',
      runId: '987654',
      runAttempt: '1',
      subjectTokenId: randomUUID(),
    },
    ...overrides,
  };
}

const RUN_ATTRIBUTES = {
  grantType: 'ci_token_exchange',
  policy: 'ci-example-smoke',
  repositoryId: '111111',
  githubEnvironment: 'smoke',
  ref: 'refs/heads/main',
  sha: 'a'.repeat(40),
  eventName: 'workflow_dispatch',
  jobWorkflowRef: 'Example-Org/example/.github/workflows/smoke.yml@refs/heads/main',
  runId: '987654',
  runAttempt: '1',
  scopes: ['kilo-gateway:inference'],
  audiences: ['kilo-gateway'],
};

describe('uts.exchange_ci_token', () => {
  it('issues for an active account and writes ci_token.issued with the token, policy and run', async () => {
    const accountId = await insertAccount(owner);
    const request = input(accountId);
    const result = await store.exchange(request);
    if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`);
    const rows = await auditRows(accountId);
    expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.ci_token.issued']);
    const [row] = rows;
    expect(row.event.data).toMatchObject({
      classUid: 6003,
      activityId: 1,
      outcome: 'success',
      actor: { kind: 'user', id: accountId },
    });
    expect(row.event.data.attributes).toEqual({
      ...RUN_ATTRIBUTES,
      subjectTokenRef: request.run.subjectTokenId,
      tokenRefs: [result.tokenId],
      tokenLifetimeSeconds: ['3600'],
    });
  });

  it('refuses a blocked or missing account and writes ci_token.denied', async () => {
    const blocked = await insertAccount(owner);
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [blocked]
    );
    const missing = `ci/missing-${randomUUID()}`;
    for (const accountId of [blocked, missing]) {
      expect(await store.exchange(input(accountId))).toEqual({ outcome: 'account_inactive' });
      const rows = await auditRows(accountId);
      expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.ci_token.denied']);
      expect(rows[0].event.data).toMatchObject({
        outcome: 'denied',
        outcomeDetail: 'account_inactive',
      });
      expect(rows[0].event.data.attributes).not.toHaveProperty('tokenRefs');
    }
  });

  it('writes only the denied row for a refusal the Worker passes, even for an active account', async () => {
    const accountId = await insertAccount(owner);
    for (const refusal of ['binding_mismatch', 'scope_not_granted'] as const) {
      expect(await store.exchange(input(accountId, { refusal }))).toEqual({ outcome: 'refused' });
    }
    const rows = await auditRows(accountId);
    expect(rows.map(row => [row.type, row.event.data.outcomeDetail])).toEqual([
      ['ai.kilo.uts.ci_token.denied', 'binding_mismatch'],
      ['ai.kilo.uts.ci_token.denied', 'scope_not_granted'],
    ]);
  });

  it('blocking the CI account puts a subject entry on the feed that covers every token it was issued, and refuses new ones', async () => {
    const accountId = await insertAccount(owner);
    // The token's iat: the Worker stamps it just before the statement runs.
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const issued = await store.exchange(input(accountId));
    if (issued.outcome !== 'issued') throw new Error(`expected issued, got ${issued.outcome}`);
    const blocked = await subjects.applyOperation({
      environment: 'development',
      workload: 'web',
      operation: 'revoke',
      operationId: randomUUID(),
      subject: accountId,
      reason: 'access_block',
      actor: 'admin:staff-1',
      sourceVersion: 1,
    });
    if (blocked.outcome !== 'applied') throw new Error(`block answered ${blocked.outcome}`);
    const subject = blocked.feedEntries.find(entry => entry.kind === 'subject');
    if (subject?.kind !== 'subject') throw new Error('expected a subject entry');
    expect(subject.id).toBe(accountId);
    // The feed compares whole seconds: every token whose iat is at or before this is revoked.
    expect(Math.floor(subject.revokedBefore / 1000)).toBeGreaterThanOrEqual(issuedAtSeconds);
    // The entry stays on the feed past the longest CI token issued before the block.
    expect(subject.expiresAt - subject.revokedAt).toBeGreaterThan(3600 * 1000);
    expect(blocked.feedEntries.map(entry => [entry.kind, entry.id])).toContainEqual([
      'blocked_account',
      accountId,
    ]);
    expect(await store.exchange(input(accountId))).toEqual({ outcome: 'account_inactive' });
  });

  it('raises for a lifetime outside 60 to 3600 seconds, an unknown refusal, a malformed scope and a missing input', async () => {
    const accountId = await insertAccount(owner);
    const call = (text: string, values: unknown[]) => async () => owner.query(text, values);
    const statement = `SELECT * FROM uts.exchange_ci_token(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;
    const values = (overrides: Record<number, unknown>) => {
      const base: unknown[] = [
        'development',
        'ci-example-smoke',
        accountId,
        'kilo-gateway:inference',
        3600,
        null,
        '111111',
        'smoke',
        'refs/heads/main',
        'a'.repeat(40),
        'push',
        'Example-Org/example/.github/workflows/smoke.yml@refs/heads/main',
        '1',
        '1',
        randomUUID(),
      ];
      for (const [index, value] of Object.entries(overrides)) base[Number(index)] = value;
      return base;
    };
    expect(await sqlStateOf(call(statement, values({ 4: 3601 })))).toBe('22023');
    expect(await sqlStateOf(call(statement, values({ 4: 59 })))).toBe('22023');
    expect(await sqlStateOf(call(statement, values({ 5: 'other' })))).toBe('22023');
    expect(await sqlStateOf(call(statement, values({ 3: 'Not A Scope' })))).toBe('22023');
    expect(await sqlStateOf(call(statement, values({ 6: null })))).toBe('22004');
    expect(await auditRows(accountId)).toEqual([]);
  });
});
