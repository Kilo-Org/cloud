import { randomBytes, randomUUID } from 'node:crypto';
import { type AuditEvent, OCSF_API_ACTIVITY, OCSF_CLASS } from '@kilocode/sts-contracts';
import pg from 'pg';
import { inject } from 'vitest';
import { identityStoreTypes } from '../../src/db/client';
import { type LoginRole, databaseUrl, withAdmin } from './connection';

/**
 * Test databases on the local identity-store Postgres. The global setup migrates one template
 * database; each test file clones it, or starts from an empty database, and drops its clone at
 * the end.
 */

export class TestDatabase {
  readonly name: string;
  readonly #clients: pg.Client[] = [];

  private constructor(name: string) {
    this.name = name;
  }

  static async create(source: 'template' | 'empty' = 'template'): Promise<TestDatabase> {
    const name = `uts_t_${randomBytes(6).toString('hex')}`;
    const template = source === 'template' ? ` TEMPLATE ${inject('templateDatabase')}` : '';
    await withAdmin(undefined, client => client.query(`CREATE DATABASE ${name}${template}`));
    return new TestDatabase(name);
  }

  url(login?: LoginRole): string {
    return databaseUrl(
      this.name,
      login === undefined ? undefined : { role: login, password: loginPassword() }
    );
  }

  /** A connection as one login, or as the admin login when `login` is omitted. */
  async connect(login?: LoginRole): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: this.url(login), types: identityStoreTypes });
    await client.connect();
    this.#clients.push(client);
    return client;
  }

  /** An admin connection acting as `uts_owner`, which owns every identity-store object. */
  async connectAsOwner(): Promise<pg.Client> {
    const client = await this.connect();
    await client.query('SET ROLE uts_owner');
    return client;
  }

  async drop(): Promise<void> {
    await Promise.allSettled(this.#clients.map(client => client.end()));
    await withAdmin(undefined, client =>
      client.query(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`)
    );
  }
}

/** This run's password of every UTS login (see `global-setup.ts`). */
export function loginPassword(): string {
  return inject('loginPassword');
}

/**
 * The relay's read for one shard: rows past the shard's watermark and below the oldest open
 * transaction, oldest first. The watermark drives a lateral probe, so the row comparison is an
 * index condition on every partition and relayed rows are never read (README, "Audit outbox").
 * Parameters: `$1` the shard, `$2` the batch size.
 */
export const RELAY_READ = `SELECT event.*
  FROM uts.audit_relay_watermarks AS watermark
  CROSS JOIN LATERAL (
    SELECT candidate.*
    FROM uts.audit_events AS candidate
    WHERE candidate.shard = watermark.shard
      AND (candidate.txid, candidate.id) > (watermark.last_txid, watermark.last_id)
      AND candidate.txid < pg_snapshot_xmin(pg_current_snapshot())
    ORDER BY candidate.txid, candidate.id
    LIMIT $2
  ) AS event
  WHERE watermark.shard = $1
  ORDER BY event.txid, event.id`;

/** Runs `work` and returns the SQLSTATE it fails with. */
export async function sqlStateOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof pg.DatabaseError && error.code !== undefined) return error.code;
    throw error;
  }
  throw new Error('expected the statement to fail');
}

export function randomHash(): Buffer {
  return randomBytes(32);
}

/** A valid UTS audit event; `overrides` replace top-level envelope fields. */
export function auditEvent(
  eventId: string = randomUUID(),
  overrides: Partial<AuditEvent> = {}
): AuditEvent {
  return {
    specversion: '1.0',
    id: eventId,
    source: 'kilo:uts:development',
    type: 'ai.kilo.uts.token.minted',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.create,
      outcome: 'success',
      actor: { kind: 'user', id: 'oauth/test' },
      attributes: { requestingService: 'kilo-cli', tokenRef: 'jti-test' },
    },
    ...overrides,
  };
}

/** Inserts one audit row as `client`'s role and returns its id, transaction id and shard. */
export async function insertAudit(client: pg.Client, event: AuditEvent = auditEvent()) {
  const result = await client.query<{ id: bigint; txid: bigint; shard: number }>(
    `INSERT INTO uts.audit_events (event_id, event_type, event) VALUES ($1, $2, $3)
     RETURNING id, txid, shard`,
    [event.id, event.type, event]
  );
  return result.rows[0];
}

export async function insertAccount(client: pg.Client): Promise<string> {
  const id = `oauth/test-${randomUUID()}`;
  await client.query('INSERT INTO uts.accounts (id, primary_email) VALUES ($1, $2)', [
    id,
    `${randomBytes(4).toString('hex')}@example.com`,
  ]);
  return id;
}

export async function insertBrowserSession(client: pg.Client, accountId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
     VALUES ($1, $2, now(), '{oauth}', now() + interval '14 days', now() + interval '30 days')
     RETURNING id`,
    [accountId, randomHash()]
  );
  return result.rows[0].id;
}

export async function insertDeviceSession(
  client: pg.Client,
  accountId: string,
  clientClass: 'desktop' | 'mobile' = 'desktop'
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO uts.device_sessions (account_id, client_class, device_label, platform, auth_time, amr)
     VALUES ($1, $2, 'test device', 'linux', now(), '{passkey}')
     RETURNING id`,
    [accountId, clientClass]
  );
  return result.rows[0].id;
}

export async function insertGatePass(
  client: pg.Client,
  accountId: string,
  action:
    | 'pat_create'
    | 'bot_key_create'
    | 'device_approve'
    | 'third_party_approve'
    | 'ci_policy_create'
): Promise<string> {
  const browserSessionId = await insertBrowserSession(client, accountId);
  const result = await client.query<{ id: string }>(
    `INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
     VALUES ($1, $2, 'b', $3, '{recent_sign_in}', now() + interval '10 minutes')
     RETURNING id`,
    [accountId, browserSessionId, action]
  );
  return result.rows[0].id;
}

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
    loginPassword: string;
  }
}
