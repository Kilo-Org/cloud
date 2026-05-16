/**
 * Tiny SQL parser used by `generate-from-schema.ts`.
 *
 * This is intentionally not a real MySQL parser — it knows just enough to
 * read `wasteland/schema/commons.sql`:
 *
 *  - `CREATE TABLE IF NOT EXISTS <name> ( ... );` blocks
 *  - per-column definitions: `<name> <type>(<args>) [NOT NULL] [DEFAULT <expr>] [PRIMARY KEY]`
 *  - table-level constraints: `PRIMARY KEY (col)`, `UNIQUE KEY ... (cols)`, `CHECK (...)`.
 *
 * Anything it does not recognise (CHECK, UNIQUE KEY, etc.) is preserved
 * verbatim in `extraConstraints` so we can re-emit the DDL byte-for-byte
 * in `COMMONS_SCHEMA_STATEMENTS`.
 */

export type ColumnType =
  | { kind: 'varchar'; length: number }
  | { kind: 'text' }
  | { kind: 'int' }
  | { kind: 'tinyint'; length: number }
  | { kind: 'float' }
  | { kind: 'json' }
  | { kind: 'timestamp' }
  | { kind: 'datetime' }
  | { kind: 'unknown'; raw: string };

export type ParsedColumn = {
  name: string;
  rawName: string;
  type: ColumnType;
  rawType: string;
  notNull: boolean;
  isPrimaryKey: boolean;
  default: string | null;
};

export type ParsedTable = {
  name: string;
  columns: ParsedColumn[];
  primaryKey: string | null;
  extraConstraints: string[];
  rawDdl: string;
};

export type ParsedSchema = {
  tables: ParsedTable[];
  /**
   * Top-level statements in source order, each without its trailing `;`.
   * Includes `CREATE TABLE` blocks AND non-DDL like `INSERT IGNORE INTO _meta`.
   */
  statements: string[];
};

/**
 * Strip line comments (`-- ...`) but not block comments. `commons.sql` does
 * not currently use either; we keep the helper trivial and document the
 * limitation.
 */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

/**
 * Split SQL into top-level statements at semicolons that appear outside of
 * parentheses and string literals. We don't try to handle MySQL `DELIMITER`
 * tricks because `commons.sql` doesn't use them.
 */
export function splitStatements(sql: string): string[] {
  const cleaned = stripLineComments(sql);
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inBacktick = false;
  let buf = '';

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    buf += ch;
    if (inSingle) {
      if (ch === "'" && cleaned[i - 1] !== '\\') inSingle = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      const stmt = buf.slice(0, -1).trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

const VARCHAR_RE = /^varchar\((\d+)\)$/i;
const TINYINT_RE = /^tinyint\((\d+)\)$/i;

function parseColumnType(raw: string): ColumnType {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const varcharMatch = VARCHAR_RE.exec(lower);
  if (varcharMatch) return { kind: 'varchar', length: Number(varcharMatch[1]) };
  const tinyintMatch = TINYINT_RE.exec(lower);
  if (tinyintMatch) return { kind: 'tinyint', length: Number(tinyintMatch[1]) };
  if (lower === 'text') return { kind: 'text' };
  if (lower === 'int' || lower === 'integer') return { kind: 'int' };
  if (lower === 'float' || lower === 'double') return { kind: 'float' };
  if (lower === 'json') return { kind: 'json' };
  if (lower === 'timestamp') return { kind: 'timestamp' };
  if (lower === 'datetime') return { kind: 'datetime' };
  return { kind: 'unknown', raw: trimmed };
}

/**
 * Parse a single column definition line, e.g.
 *
 *   `key` VARCHAR(64) PRIMARY KEY
 *   priority INT DEFAULT 2
 *   sandbox_required TINYINT(1) DEFAULT 0
 *   tags JSON
 *
 * Returns null for non-column lines (constraints, empty lines).
 */
export function parseColumnLine(line: string): ParsedColumn | null {
  const trimmed = line.trim().replace(/,$/, '').trim();
  if (trimmed.length === 0) return null;

  const upper = trimmed.toUpperCase();
  if (
    upper.startsWith('PRIMARY KEY') ||
    upper.startsWith('UNIQUE KEY') ||
    upper.startsWith('UNIQUE (') ||
    upper.startsWith('KEY ') ||
    upper.startsWith('INDEX ') ||
    upper.startsWith('CHECK') ||
    upper.startsWith('FOREIGN KEY') ||
    upper.startsWith('CONSTRAINT')
  ) {
    return null;
  }

  // Identifier: backticked or plain.
  let rawName: string;
  let rest: string;
  if (trimmed.startsWith('`')) {
    const close = trimmed.indexOf('`', 1);
    if (close < 0) return null;
    rawName = trimmed.slice(0, close + 1);
    rest = trimmed.slice(close + 1).trim();
  } else {
    const space = trimmed.search(/\s/);
    if (space < 0) return null;
    rawName = trimmed.slice(0, space);
    rest = trimmed.slice(space).trim();
  }

  const name = rawName.replace(/^`|`$/g, '');

  // Type token: `VARCHAR(255)`, `TINYINT(1)`, `INT`, etc. May contain a
  // parenthesised arg list with no spaces in commons.sql.
  const typeMatch = /^([A-Za-z]+(?:\([^)]*\))?)/.exec(rest);
  if (!typeMatch) return null;
  const rawType = typeMatch[1];
  const tail = rest.slice(rawType.length).trim();

  const tailUpper = tail.toUpperCase();
  const notNull = /\bNOT\s+NULL\b/.test(tailUpper);
  const isPrimaryKey = /\bPRIMARY\s+KEY\b/.test(tailUpper);
  const defaultMatch = /\bDEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|PRIMARY\s+KEY|UNIQUE)\b|$)/i.exec(
    tail
  );
  const defaultValue = defaultMatch ? defaultMatch[1].trim() : null;

  return {
    name,
    rawName,
    type: parseColumnType(rawType),
    rawType,
    notNull: notNull || isPrimaryKey,
    isPrimaryKey,
    default: defaultValue,
  };
}

const CREATE_TABLE_RE =
  /^create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/i;

export function parseCreateTable(stmt: string): ParsedTable | null {
  const m = CREATE_TABLE_RE.exec(stmt.trim());
  if (!m) return null;
  const name = m[1];
  const body = m[2];

  const lines = splitColumnList(body);
  const columns: ParsedColumn[] = [];
  const extras: string[] = [];

  for (const line of lines) {
    const col = parseColumnLine(line);
    if (col) {
      columns.push(col);
      continue;
    }
    const trimmed = line.trim().replace(/,$/, '').trim();
    if (trimmed.length > 0) extras.push(trimmed);
  }

  let primaryKey: string | null = columns.find(c => c.isPrimaryKey)?.name ?? null;
  if (!primaryKey) {
    for (const extra of extras) {
      const pkMatch = /^primary\s+key\s*\(\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\)/i.exec(extra);
      if (pkMatch) {
        primaryKey = pkMatch[1];
        break;
      }
    }
  }

  return {
    name,
    columns,
    primaryKey,
    extraConstraints: extras,
    rawDdl: stmt.trim(),
  };
}

/**
 * Split a column-list body on top-level commas (i.e. commas not inside
 * parentheses). Needed for `CHECK (a BETWEEN 0 AND 1)` style entries.
 */
function splitColumnList(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inBacktick = false;
  let inSingle = false;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inSingle) {
      buf += ch;
      if (ch === "'" && body[i - 1] !== '\\') inSingle = false;
      continue;
    }
    if (inBacktick) {
      buf += ch;
      if (ch === '`') inBacktick = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      buf += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      buf += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

export function parseSchema(sql: string): ParsedSchema {
  const statements = splitStatements(sql);
  const tables: ParsedTable[] = [];
  for (const stmt of statements) {
    const table = parseCreateTable(stmt);
    if (table) tables.push(table);
  }
  return { tables, statements };
}
