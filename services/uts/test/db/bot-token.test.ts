import { randomBytes, randomUUID } from 'node:crypto';
import { AuditEventSchema } from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type BotTokenInput,
  type BotTokenStore,
  identityStoreBotTokens,
} from '../../src/bot-token/store';
import { IdentityStore } from '../../src/db/client';
import { type SubjectStore, identityStoreSubjects } from '../../src/subjects/store';
import { TestDatabase, sqlStateOf } from './harness';

/**
 * The bot-token mint's statement (migration 0026, `uts.mint_bot_token`) through the Worker's own
 * store (`src/bot-token/store.ts`), run as the app login: the issued and denied audit rows, the
 * membership rule, and the access block that stops a bot account's tokens.
 */

let db: TestDatabase;
let owner: pg.Client;
let store: BotTokenStore;
let subjects: SubjectStore;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  const app = new IdentityStore(await db.connect('uts_app_a'));
  store = identityStoreBotTokens(app);
  subjects = identityStoreSubjects(app);
});
afterAll(() => db.drop());

const ORG = randomUUID();
const AuditRowSchema = z.object({ event_type: z.string(), event: z.unknown() });

/** A bot account, an active member of `ORG` in `role` unless `role` is null. */
async function insertBot(role: string | null = 'member'): Promise<string> {
  const id = `bot-internal-test-${randomBytes(6).toString('hex')}`;
  await owner.query('INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2)', [
    id,
    `${randomBytes(4).toString('hex')}-internal-bot@example.com`,
  ]);
  if (role !== null) {
    await owner.query(
      'INSERT INTO uts.org_memberships (org_id, account_id, role, event_version) VALUES ($1, $2, $3, 1)',
      [ORG, id, role]
    );
  }
  return id;
}

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

function input(accountId: string, overrides: Partial<BotTokenInput> = {}): BotTokenInput {
  return {
    environment: 'development',
    workload: 'bouncer-watch',
    accountId,
    orgId: ORG,
    scope: 'kilo-gateway:inference',
    lifetimeSeconds: 3600,
    ...overrides,
  };
}

describe('uts.mint_bot_token', () => {
  it('issues for an active owner or member and writes bot_token.issued with the workload as actor', async () => {
    for (const role of ['member', 'owner']) {
      const accountId = await insertBot(role);
      const result = await store.mint(input(accountId));
      if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`);
      const rows = await auditRows(accountId);
      expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.bot_token.issued']);
      const [row] = rows;
      expect(row.event.source).toBe('kilo:uts:development');
      expect(row.event.data).toEqual({
        classUid: 6003,
        activityId: 1,
        outcome: 'success',
        actor: { kind: 'workload', id: 'bouncer-watch' },
        attributes: {
          grantType: 'bot_token',
          org: ORG,
          orgRole: role,
          scopes: ['kilo-gateway:inference'],
          audiences: ['kilo-gateway'],
          tokenRefs: [result.tokenId],
          tokenLifetimeSeconds: ['3600'],
        },
      });
    }
  });

  it('refuses a blocked or missing account and writes bot_token.denied', async () => {
    const blocked = await insertBot();
    await owner.query(
      `UPDATE uts.accounts SET status = 'blocked', blocked_at = now() WHERE id = $1`,
      [blocked]
    );
    const missing = `bot-internal-missing-${randomBytes(4).toString('hex')}`;
    for (const accountId of [blocked, missing]) {
      expect(await store.mint(input(accountId))).toEqual({ outcome: 'account_inactive' });
      const rows = await auditRows(accountId);
      expect(rows.map(row => row.type)).toEqual(['ai.kilo.uts.bot_token.denied']);
      expect(rows[0].event.data).toMatchObject({
        outcome: 'denied',
        outcomeDetail: 'account_inactive',
        actor: { kind: 'workload', id: 'bouncer-watch' },
      });
      expect(rows[0].event.data.attributes).not.toHaveProperty('tokenRefs');
    }
  });

  it('refuses a bot outside the organization, a removed member, and an admin or billing manager', async () => {
    const outsider = await insertBot(null);
    const removed = await insertBot('member');
    await owner.query(
      `UPDATE uts.org_memberships SET status = 'removed', removed_at = now() WHERE account_id = $1`,
      [removed]
    );
    const admin = await insertBot('admin');
    const billing = await insertBot('billing_manager');
    const elsewhere = await insertBot('member');
    for (const [accountId, orgId] of [
      [outsider, ORG],
      [removed, ORG],
      [admin, ORG],
      [billing, ORG],
      [elsewhere, randomUUID()],
    ]) {
      expect(await store.mint(input(accountId, { orgId }))).toEqual({
        outcome: 'membership_denied',
      });
      const rows = await auditRows(accountId);
      expect(rows.map(row => [row.type, row.event.data.outcomeDetail])).toEqual([
        ['ai.kilo.uts.bot_token.denied', 'membership_denied'],
      ]);
    }
  });

  it('blocking the bot account puts it on the feed past its longest token, and refuses new mints', async () => {
    const accountId = await insertBot();
    // The token's iat: the Worker stamps it just before the statement runs.
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const issued = await store.mint(input(accountId));
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
    expect(Math.floor(subject.revokedBefore / 1000)).toBeGreaterThanOrEqual(issuedAtSeconds);
    expect(subject.expiresAt - subject.revokedAt).toBeGreaterThan(3600 * 1000);
    expect(blocked.feedEntries.map(entry => [entry.kind, entry.id])).toContainEqual([
      'blocked_account',
      accountId,
    ]);
    expect(await store.mint(input(accountId))).toEqual({ outcome: 'account_inactive' });
  });

  it('raises for a bad lifetime, scope, account id or workload and a missing input, and writes nothing', async () => {
    const accountId = await insertBot();
    const statement = 'SELECT * FROM uts.mint_bot_token($1, $2, $3, $4, $5, $6)';
    const call = (overrides: Record<number, unknown>) => async () => {
      const values: unknown[] = [
        'development',
        'bouncer-watch',
        accountId,
        ORG,
        'kilo-gateway:inference',
        3600,
      ];
      for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
      return await owner.query(statement, values);
    };
    expect(await sqlStateOf(call({ 5: 3601 }))).toBe('22023');
    expect(await sqlStateOf(call({ 5: 59 }))).toBe('22023');
    expect(await sqlStateOf(call({ 4: 'Not A Scope' }))).toBe('22023');
    expect(await sqlStateOf(call({ 1: 'Bouncer Watch' }))).toBe('22023');
    expect(await sqlStateOf(call({ 2: 'oauth/test-human' }))).toBe('22023');
    expect(await sqlStateOf(call({ 3: null }))).toBe('22004');
    expect(await auditRows(accountId)).toEqual([]);
  });
});
