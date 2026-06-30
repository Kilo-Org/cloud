import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { z } from 'zod';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { computeDatabaseUrl, getDatabaseClientConfig } from './database-url';

const migrationsSchema = 'drizzle';
const migrationsTable = '__drizzle_migrations';
const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

const JournalSchema = z.object({
  entries: z.array(
    z.object({
      tag: z.string(),
      when: z.number(),
    })
  ),
});

type Migration = {
  tag: string;
  folderMillis: number;
  hash: string;
  sql: string[];
};

type MigrationRow = {
  created_at: number | string | null;
};

dotenv.config({ path: fileURLToPath(new URL('../../../.env.local', import.meta.url)), quiet: true });

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const lines = [error.stack ?? error.message];
    const postgresFields = [
      'code',
      'severity',
      'detail',
      'hint',
      'position',
      'where',
      'schema',
      'table',
      'column',
      'constraint',
      'routine',
    ];

    for (const field of postgresFields) {
      const value = getStringField(error, field);
      if (value) {
        lines.push(`${field}: ${value}`);
      }
    }

    return lines.join('\n');
  }

  return `Thrown value: ${String(error)}`;
}

async function readMigrations(): Promise<Migration[]> {
  const journalPath = new URL('./migrations/meta/_journal.json', import.meta.url);
  const journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')));
  const migrationFiles = readMigrationFiles({
    migrationsFolder,
    migrationsSchema,
    migrationsTable,
  });

  return journal.entries.map((entry, index) => {
    const migration = migrationFiles[index];
    if (!migration) {
      throw new Error(`Missing migration metadata for journal entry ${entry.tag}`);
    }

    return {
      tag: entry.tag,
      folderMillis: migration.folderMillis,
      hash: migration.hash,
      sql: migration.sql,
    };
  });
}

function getLastMigrationMillis(row: MigrationRow | undefined): number | undefined {
  if (!row || row.created_at === null) {
    return undefined;
  }

  const createdAt = Number(row.created_at);
  if (!Number.isFinite(createdAt)) {
    throw new Error(`Unexpected latest migration timestamp: ${String(row.created_at)}`);
  }

  return createdAt;
}

async function main(): Promise<void> {
  const migrations = await readMigrations();
  const pool = new Pool({ ...getDatabaseClientConfig(computeDatabaseUrl()), max: 1 });
  const client = await pool.connect();

  try {
    const quotedSchema = quoteIdentifier(migrationsSchema);
    const quotedTable = quoteIdentifier(migrationsTable);
    const migrationLogTable = `${quotedSchema}.${quotedTable}`;

    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${migrationLogTable} (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const latestMigration = await client.query<MigrationRow>(
      `SELECT created_at FROM ${migrationLogTable} ORDER BY created_at DESC LIMIT 1`
    );
    const lastMigrationMillis = getLastMigrationMillis(latestMigration.rows[0]);
    const pendingMigrations = migrations.filter(
      migration => lastMigrationMillis === undefined || lastMigrationMillis < migration.folderMillis
    );

    console.log(`Loaded ${migrations.length} migrations from ${migrationsFolder}`);
    console.log(`Found ${pendingMigrations.length} pending migrations`);

    if (pendingMigrations.length === 0) {
      return;
    }

    await client.query('BEGIN');
    try {
      for (const migration of pendingMigrations) {
        console.log(`::group::Applying migration ${migration.tag}`);
        try {
          console.log(
            `Migration timestamp ${migration.folderMillis}, sha256 ${migration.hash.slice(0, 12)}`
          );

          for (const [index, statement] of migration.sql.entries()) {
            console.log(`Executing statement ${index + 1}/${migration.sql.length}`);
            console.log(statement.trim());
            await client.query(statement);
          }

          await client.query(
            `INSERT INTO ${migrationLogTable} (hash, created_at) VALUES ($1, $2)`,
            [migration.hash, migration.folderMillis]
          );
          console.log(`Applied migration ${migration.tag}`);
        } catch (error) {
          console.error(`Failed migration ${migration.tag}`);
          console.error(formatError(error));
          throw error;
        } finally {
          console.log('::endgroup::');
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error('Drizzle migrations failed');
  console.error(formatError(error));
  process.exitCode = 1;
});
