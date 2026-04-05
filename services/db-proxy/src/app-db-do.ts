import { DurableObject } from 'cloudflare:workers';
import type {
  QueryMethod,
  QuerySuccessResponse,
  SchemaResponse,
  TableInfo,
  IndexInfo,
} from './types';
import { generateToken, verifyToken } from './utils/auth';

// Storage key for DO transient storage (isolated from SQL)
const TOKEN_STORAGE_KEY = 'db_token';

// Type needed for DO
type Env = {
  APP_DB: DurableObjectNamespace;
  DB_PROXY_ADMIN_TOKEN: string;
};

/**
 * Durable Object for per-app SQLite database
 * One DO instance per app, keyed by idFromName(appId)
 */
export class AppDbDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Required fetch method for DurableObject interface
   * Not used since we call methods directly
   */
  fetch(): Response {
    return new Response('Direct method calls only', { status: 400 });
  }

  /**
   * Helper to execute SQL with typed results
   */
  private sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T[] {
    // Build the SQL with positional parameters
    let sql = strings[0];
    const params: unknown[] = [];

    for (let i = 0; i < values.length; i++) {
      sql += `?${strings[i + 1]}`;
      params.push(values[i]);
    }

    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    return cursor.toArray() as T[];
  }

  /**
   * Provision the database - generate token if not exists
   * Returns the plaintext token
   * Token is stored in DO transient storage, isolated from SQL access
   */
  async provision(): Promise<{ token: string; isNew: boolean }> {
    const existingToken = await this.getToken();

    if (existingToken) {
      return { token: existingToken, isNew: false };
    }

    // Generate new token and store in DO transient storage
    const token = generateToken();
    await this.ctx.storage.put(TOKEN_STORAGE_KEY, token);

    return { token, isNew: true };
  }

  async isProvisioned(): Promise<boolean> {
    return (await this.getToken()) !== null;
  }

  async getToken(): Promise<string | null> {
    const token = await this.ctx.storage.get<string>(TOKEN_STORAGE_KEY);
    return token ?? null;
  }

  async verifyToken(providedToken: string): Promise<boolean> {
    const storedToken = await this.getToken();

    if (!storedToken) {
      return false;
    }

    return verifyToken(providedToken, storedToken);
  }

  executeQuery(sqlText: string, params: unknown[], method: QueryMethod): QuerySuccessResponse {
    const cursor = this.ctx.storage.sql.exec(sqlText, ...params);

    switch (method) {
      case 'get': {
        const rows = cursor.toArray();
        if (rows.length === 0) {
          return { rows: [] };
        }
        return { rows: Object.values(rows[0] as Record<string, unknown>) };
      }
      case 'all': {
        const rows = cursor.toArray();
        const valueRows = rows.map(row => Object.values(row as Record<string, unknown>));
        return { rows: valueRows };
      }
      case 'run': {
        return { rows: [] };
      }
      case 'values': {
        const rows = cursor.toArray();
        const valueRows = rows.map(row => Object.values(row as Record<string, unknown>));
        return { rows: valueRows };
      }
    }
  }

  /**
   * Execute a batch of queries in a transaction
   * Used by Drizzle's migration runner for atomic schema changes
   */
  executeBatch(
    queries: Array<{ sql: string; params: unknown[]; method: QueryMethod }>
  ): Array<QuerySuccessResponse> {
    return this.ctx.storage.transactionSync(() => {
      const results: Array<QuerySuccessResponse> = [];
      for (const query of queries) {
        const result = this.executeQuery(query.sql, query.params, query.method);
        results.push(result);
      }
      return results;
    });
  }

  /**
   * Get database schema (tables and indexes, excluding internal tables)
   */
  getSchema(): SchemaResponse {
    // Get all tables excluding internal ones
    const tables = this.sql<TableInfo>`
      SELECT name, type, sql FROM sqlite_master
      WHERE type = 'table'
      AND name NOT LIKE '__\_%' ESCAPE '\\'
      AND name NOT LIKE 'sqlite_%'
      AND sql IS NOT NULL
      ORDER BY name
    `;

    // Get all indexes excluding internal ones
    const indexes = this.sql<IndexInfo>`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index'
      AND name NOT LIKE 'sqlite_%'
      AND sql IS NOT NULL
      ORDER BY name
    `;

    return {
      tables: tables.map(t => ({ name: t.name, sql: t.sql })),
      indexes: indexes.map(i => ({ name: i.name, sql: i.sql })),
    };
  }

  /**
   * Export database as SQL dump
   */
  exportDump(): string {
    const lines: string[] = [];
    lines.push('-- SQLite dump');
    lines.push(`-- Generated at ${new Date().toISOString()}`);
    lines.push('');

    // Get schema
    const schema = this.getSchema();

    // Export table schemas and data
    for (const table of schema.tables) {
      lines.push(`-- Table: ${table.name}`);
      lines.push(`${table.sql};`);
      lines.push('');

      // Export data - use raw SQL to query dynamic table name
      const cursor = this.ctx.storage.sql.exec(`SELECT * FROM "${table.name}"`);
      const rows = cursor.toArray();

      for (const row of rows) {
        const typedRow = row as Record<string, unknown>;
        const columns = Object.keys(typedRow);
        const values = Object.values(typedRow).map(v => {
          if (v === null) return 'NULL';
          if (typeof v === 'number') return v.toString();
          if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
          return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
        });
        lines.push(
          `INSERT INTO "${table.name}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});`
        );
      }
      lines.push('');
    }

    // Export indexes
    for (const index of schema.indexes) {
      lines.push(`-- Index: ${index.name}`);
      lines.push(`${index.sql};`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
