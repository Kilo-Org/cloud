import { describe, expect, it } from 'vitest';
import { parseColumnLine, parseCreateTable, parseSchema, splitStatements } from './sql-parser';

const FIXTURE = `CREATE TABLE IF NOT EXISTS _meta (
    \`key\` VARCHAR(64) PRIMARY KEY,
    value TEXT
);

INSERT IGNORE INTO _meta (\`key\`, value) VALUES ('schema_version', '1.2');

CREATE TABLE IF NOT EXISTS wanted (
    id VARCHAR(64) PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    priority INT DEFAULT 2,
    sandbox_required TINYINT(1) DEFAULT 0,
    tags JSON,
    created_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rig_links (
    id VARCHAR(64) PRIMARY KEY,
    rig_a VARCHAR(255) NOT NULL,
    rig_b VARCHAR(255) NOT NULL,
    UNIQUE KEY uq_rig_pair (rig_a, rig_b),
    CHECK (rig_a != rig_b)
);
`;

describe('splitStatements', () => {
  it('splits at top-level semicolons', () => {
    const stmts = splitStatements(FIXTURE);
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toContain('CREATE TABLE IF NOT EXISTS _meta');
    expect(stmts[1]).toMatch(/^INSERT IGNORE INTO _meta/);
    expect(stmts[2]).toContain('CREATE TABLE IF NOT EXISTS wanted');
    expect(stmts[3]).toContain('CREATE TABLE IF NOT EXISTS rig_links');
  });

  it('does not split on semicolons inside string literals', () => {
    const stmts = splitStatements(`INSERT INTO t (v) VALUES ('a;b'); SELECT 1;`);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe(`INSERT INTO t (v) VALUES ('a;b')`);
  });
});

describe('parseColumnLine', () => {
  it('parses a backtick-quoted PRIMARY KEY column', () => {
    const col = parseColumnLine('`key` VARCHAR(64) PRIMARY KEY');
    expect(col).not.toBeNull();
    expect(col?.name).toBe('key');
    expect(col?.rawName).toBe('`key`');
    expect(col?.type).toEqual({ kind: 'varchar', length: 64 });
    expect(col?.isPrimaryKey).toBe(true);
    expect(col?.notNull).toBe(true);
  });

  it('parses NOT NULL', () => {
    const col = parseColumnLine('title TEXT NOT NULL');
    expect(col?.notNull).toBe(true);
    expect(col?.isPrimaryKey).toBe(false);
    expect(col?.type).toEqual({ kind: 'text' });
  });

  it('parses INT with DEFAULT', () => {
    const col = parseColumnLine('priority INT DEFAULT 2');
    expect(col?.type).toEqual({ kind: 'int' });
    expect(col?.default).toBe('2');
    expect(col?.notNull).toBe(false);
  });

  it('parses TINYINT(1) with DEFAULT', () => {
    const col = parseColumnLine('sandbox_required TINYINT(1) DEFAULT 0');
    expect(col?.type).toEqual({ kind: 'tinyint', length: 1 });
    expect(col?.default).toBe('0');
  });

  it('parses VARCHAR DEFAULT with quoted value', () => {
    const col = parseColumnLine("status VARCHAR(32) DEFAULT 'open'");
    expect(col?.default).toBe("'open'");
  });

  it('parses JSON column', () => {
    const col = parseColumnLine('tags JSON');
    expect(col?.type).toEqual({ kind: 'json' });
    expect(col?.notNull).toBe(false);
  });

  it('parses TIMESTAMP column', () => {
    const col = parseColumnLine('created_at TIMESTAMP');
    expect(col?.type).toEqual({ kind: 'timestamp' });
  });

  it('returns null for table-level constraints', () => {
    expect(parseColumnLine('PRIMARY KEY (id)')).toBeNull();
    expect(parseColumnLine('UNIQUE KEY uq_rig_pair (rig_a, rig_b)')).toBeNull();
    expect(parseColumnLine('CHECK (rig_a != rig_b)')).toBeNull();
  });
});

describe('parseCreateTable', () => {
  it('extracts columns and primary key', () => {
    const stmts = splitStatements(FIXTURE);
    const table = parseCreateTable(stmts[2]);
    expect(table).not.toBeNull();
    expect(table?.name).toBe('wanted');
    expect(table?.primaryKey).toBe('id');
    expect(table?.columns.map(c => c.name)).toEqual([
      'id',
      'title',
      'description',
      'priority',
      'sandbox_required',
      'tags',
      'created_at',
    ]);
  });

  it('captures table-level constraints in extraConstraints', () => {
    const stmts = splitStatements(FIXTURE);
    const table = parseCreateTable(stmts[3]);
    expect(table?.name).toBe('rig_links');
    expect(table?.extraConstraints).toEqual([
      'UNIQUE KEY uq_rig_pair (rig_a, rig_b)',
      'CHECK (rig_a != rig_b)',
    ]);
  });
});

describe('parseSchema', () => {
  it('returns tables in source order plus the full statement list', () => {
    const schema = parseSchema(FIXTURE);
    expect(schema.tables.map(t => t.name)).toEqual(['_meta', 'wanted', 'rig_links']);
    expect(schema.statements).toHaveLength(4);
  });
});
