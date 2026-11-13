/* eslint-disable import/no-nodejs-modules -- the upgrade runs the shipped migrations through real SQL, as `database.test-helpers.ts` does */
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import migrations from '../../../drizzle/migrations';

// The forward editor used to hand a reopened "Add forward" the previous draft,
// so a device could already hold two rows for one bind address when the unique
// index arrives. The upgrade drops the later row of each pair first, otherwise
// creating the index fails and the app cannot open its database.

const bundle = z
  .object({
    journal: z.object({ entries: z.array(z.object({ idx: z.number().int(), tag: z.string() })) }),
    migrations: z.record(z.string(), z.string()),
  })
  .parse(migrations);

/** The shipped migrations up to (and excluding) the one at `before`. */
function applyUpTo(database: DatabaseSync, before: number): void {
  for (const entry of bundle.journal.entries.filter(item => item.idx < before)) {
    const sql = bundle.migrations[`m${String(entry.idx).padStart(4, '0')}`];
    if (!sql) {
      throw new Error(`Missing migration: ${entry.tag}`);
    }
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) {
        database.exec(statement);
      }
    }
  }
}

const FORWARD_INDEX_MIGRATION = 5;

describe('the ssh_forwards bind index migration', () => {
  it('creates the index on a database that holds the duplicates it prevents', () => {
    const database = new DatabaseSync(':memory:');
    applyUpTo(database, FORWARD_INDEX_MIGRATION);
    database.exec(
      `insert into ssh_hosts (id, label, hostname, port, username, auth_method, created_at, updated_at)
       values ('host-1', 'target', 'target', 22, 'user', 'password', 0, 0)`
    );
    for (const id of ['kept', 'dropped']) {
      database.exec(
        `insert into ssh_forwards (id, host_id, direction, bind_host, bind_port,
           destination_host, destination_port, auto_start, label)
         values ('${id}', 'host-1', 'local', '127.0.0.1', 18080, 'http', 8080, 0, null)`
      );
    }

    const sql = bundle.migrations[`m${String(FORWARD_INDEX_MIGRATION).padStart(4, '0')}`];
    for (const statement of (sql ?? '').split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) {
        database.exec(statement);
      }
    }

    expect(database.prepare('select id from ssh_forwards').all()).toEqual([{ id: 'kept' }]);
    expect(
      database
        .prepare(
          "select name from sqlite_master where type = 'index' and name = 'ssh_forwards_bind'"
        )
        .all()
    ).toEqual([{ name: 'ssh_forwards_bind' }]);
  });
});
