/**
 * Library for the Kilo MCP tRPC catalog dump.
 *
 * Enumerates every procedure from the live `rootRouter` (never a hand-written
 * list), shapes deterministic catalog rows, preserves author-edited summaries
 * from the committed `services/kilo-mcp/catalog.json`, and generates missing
 * summaries with the Kilo CLI (`kilo run`, pinned model + variant). Summaries
 * are never generated at MCP runtime: the committed catalog is the only runtime
 * artifact, and authors edit its summaries by hand. See dump.ts for the CLI
 * entry point.
 *
 * Queries and mutations are published wholesale; paths with an internal-only
 * segment (`admin`, `dev`, `test`) and subscriptions stay internal. `debug`
 * paths are published too, marked with `debug: true` for the guard.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';

/** Repository root: five levels above apps/web/src/scripts/mcp-catalog. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/** Absolute path of the committed catalog consumed by services/kilo-mcp. */
export const CATALOG_JSON_PATH = join(REPO_ROOT, 'services', 'kilo-mcp', 'catalog.json');

/**
 * Repo-relative display form of the catalog path for CLI output. The absolute
 * path leaks the machine-specific checkout directory into logs and CI
 * comments and is long enough to be quoted only in abbreviated form; the
 * repo-relative form is stable in every checkout and matches how docs and CI
 * refer to the file.
 */
export const CATALOG_JSON_DISPLAY_PATH = relative(REPO_ROOT, CATALOG_JSON_PATH);

/** Source of truth for the enumeration; imported dynamically by dump.ts. */
export const ROOT_ROUTER_PATH = join(__dirname, '..', '..', 'routers', 'root-router.ts');

/**
 * Whether a procedure path is internal-only. A path is internal when any
 * segment is `test` or starts with `admin` or `dev` — the routers name admin
 * and dev-only procedures `adminX` and `devX` (for example
 * `organizations.admin.grantCredit` and `slack.devRemoveDbRowOnly`). `test`
 * stays exact-only so user-facing calls such as `slack.testConnection` remain
 * published, and `debug` stays published too: its rows carry a `debug: true`
 * marker and are guarded wherever they are offered or called. Subscriptions
 * are never exported regardless of this check.
 */
export function isDenylistedPath(path: string): boolean {
  return path.split('.').some(segment => {
    const lower = segment.toLowerCase();
    return lower === 'test' || lower.startsWith('admin') || lower.startsWith('dev');
  });
}

/**
 * Procedure builders that reject non-admin users. `apps/web/src/lib/trpc/init.ts`
 * builds every admin-only procedure from `adminProcedure`, and the other three
 * variants chain on it, so a chain whose head is any of these is admin-guarded.
 */
export const ADMIN_GUARD_PROCEDURES = [
  'adminProcedure',
  'creditManagerProcedure',
  'superadminProcedure',
  'sessionViewerProcedure',
] as const;

/** Instruction every generated summary must follow. */
export const SUMMARY_INSTRUCTION =
  'Write a 1-2 sentence search-friendly summary of what this call does, in words an agent would type to find it. No implementation detail. Not a restatement of the path.';

const CONTEXT_CHAR_LIMIT = 4_000;
const FILE_CONTEXT_CHAR_LIMIT = 60_000;

/**
 * Pinned summarizer: the same model and reasoning effort for every generated
 * summary, so catalog text stays consistent across runs and authors.
 */
export const SUMMARY_MODEL = 'kilo/deepseek/deepseek-v4.1-flash';
export const SUMMARY_VARIANT = 'max';
/** `kilo run` invocation timeout: a whole batch (file source included) must fit. */
const SUMMARY_RUN_TIMEOUT_MS = 10 * 60 * 1000;

export type CatalogLeaf = {
  path: string;
  type: string;
  /**
   * Zod input schemas in `.input()` order. A chained procedure has more than
   * one; the list is empty when the procedure takes no input.
   */
  inputs: unknown[];
};

export type CatalogRow = {
  path: string;
  kind: 'query' | 'mutation';
  summary: string;
  inputSchema: Record<string, unknown>;
  tags: string[];
  searchBlob: string;
  /**
   * Emitted only on rows whose procedure sits behind an admin guard;
   * absent means every grant may use the row.
   */
  admin?: true;
  /**
   * Emitted only on rows whose procedure's top-level segment is `debug`;
   * absent means the row is not a debug endpoint. A debug row behind an admin
   * guard carries both marks.
   */
  debug?: true;
};

/** Failure while generating summaries. `retryable` failures name the failed batch. */
export class CatalogSummaryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean }) {
    super(message);
    this.name = 'CatalogSummaryError';
    this.retryable = options.retryable;
  }
}

type LooseProcedure = { _def?: { type?: unknown; inputs?: unknown[] } };

/**
 * Flattens a tRPC router into leaves. tRPC merges sub-routers into
 * `_def.procedures` keyed by the full dotted path; each entry exposes
 * `_def.type` ('query' | 'mutation' | 'subscription') and `_def.inputs`, the
 * list of Zod schemas passed to `.input()` (empty when the procedure takes
 * no input).
 */
export function collectCatalogLeaves(router: { _def?: unknown }): CatalogLeaf[] {
  const procedures = (router?._def as { procedures?: unknown } | undefined)?.procedures;
  if (!procedures || typeof procedures !== 'object') {
    throw new Error('rootRouter exposed no procedures record — cannot enumerate the catalog');
  }
  const leaves: CatalogLeaf[] = [];
  for (const [path, entry] of Object.entries(procedures as Record<string, unknown>)) {
    const def = (entry as LooseProcedure | undefined)?._def;
    if (!def) continue;
    const inputs = Array.isArray(def.inputs) ? def.inputs : [];
    leaves.push({
      path,
      type: typeof def.type === 'string' ? def.type : '',
      inputs,
    });
  }
  if (leaves.length === 0) {
    throw new Error('rootRouter exposed zero procedures — cannot enumerate the catalog');
  }
  return leaves;
}

function singleInputSchema(input: unknown): Record<string, unknown> {
  // `io: 'input'` keeps the schema faithful for callers that build a request;
  // `unrepresentable: 'any'` keeps rare schemas (z.any(), z.date(), …) from
  // failing the whole dump.
  return z.toJSONSchema(input as z.ZodType, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keywords a merged object schema can carry without changing the runtime
 * contract. `additionalProperties` is deliberately absent: a `.strict()`
 * subschema rejects keys another subschema contributes, so flattening it into
 * the union would advertise a more permissive schema than tRPC enforces.
 */
const MERGEABLE_OBJECT_KEYWORDS = new Set(['$schema', 'type', 'properties', 'required']);

function isMergeableObjectSchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === 'object' &&
    isRecord(schema.properties) &&
    Object.keys(schema).every(key => MERGEABLE_OBJECT_KEYWORDS.has(key))
  );
}

/**
 * Composes every chained `.input()` schema into one JSON Schema. tRPC runs each
 * `.input()` validator against the same raw input, so a caller must satisfy all
 * of them: using only the first schema (the old behavior) under-advertised
 * chained procedures such as `workspaceFolders.create`, whose second input
 * requires `name` and `color`.
 *
 * Plain object schemas merge into a single object: properties are unioned,
 * required keys are unioned, and a key declared by more than one schema keeps
 * every constraint through `allOf`. Any other chain — a non-object schema, or
 * an object carrying extra keywords such as `.strict()`'s
 * `additionalProperties: false` — falls back to a top-level `allOf`, the
 * faithful intersection that preserves each schema's own keywords.
 */
function toInputSchema(inputs: unknown[]): Record<string, unknown> {
  const schemas = inputs.map(singleInputSchema);
  const [first] = schemas;
  if (first === undefined) return {};
  if (schemas.length === 1) return first;

  if (schemas.every(isMergeableObjectSchema)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const schema of schemas) {
      for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (!(key in properties)) properties[key] = value;
        else if (JSON.stringify(properties[key]) !== JSON.stringify(value)) {
          properties[key] = { allOf: [properties[key], value] };
        }
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (typeof key === 'string' && !required.includes(key)) required.push(key);
        }
      }
    }
    const composed: Record<string, unknown> = {};
    if (typeof first.$schema === 'string') composed.$schema = first.$schema;
    composed.type = 'object';
    composed.properties = properties;
    if (required.length > 0) composed.required = required;
    return composed;
  }

  return {
    ...(typeof first.$schema === 'string' ? { $schema: first.$schema } : {}),
    allOf: schemas.map(schema => {
      const copy = { ...schema };
      delete copy.$schema;
      return copy;
    }),
  };
}

function topSchemaKeys(inputSchema: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const properties = inputSchema.properties;
  if (isRecord(properties)) {
    for (const key of Object.keys(properties)) if (!keys.includes(key)) keys.push(key);
  }
  // Composition keywords keep their field keys in the subschemas: a chain that
  // falls back to a top-level `allOf`, and zod 4.6's top-level `anyOf` for
  // `.and()` on a union (see `personalPrepareSessionNextSchema`), whose
  // branches each carry the merged fields. Surface every subschema key so tags
  // and the search blob stay complete — `sandboxAllocation` exists only inside
  // those `anyOf` branches and otherwise drops out of the search terms while
  // staying in `inputSchema`.
  for (const keyword of ['allOf', 'anyOf'] as const) {
    const subschemas = inputSchema[keyword];
    if (!Array.isArray(subschemas)) continue;
    for (const sub of subschemas) {
      if (isRecord(sub)) {
        for (const key of topSchemaKeys(sub)) if (!keys.includes(key)) keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * Tags are derived only from the path segments plus the top-level input
 * schema property keys: lowercased, deduped, never authored.
 */
function deriveTags(segments: string[], schemaKeys: string[]): string[] {
  const tags: string[] = [];
  for (const segment of [...segments, ...schemaKeys]) {
    const tag = segment.toLowerCase();
    if (tag !== '' && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function shapeRow(leaf: CatalogLeaf, summary: string, admin: boolean, debug: boolean): CatalogRow {
  const segments = leaf.path.split('.');
  const inputSchema = toInputSchema(leaf.inputs);
  const schemaKeys = topSchemaKeys(inputSchema);
  const tags = deriveTags(segments, schemaKeys);
  return {
    path: leaf.path,
    kind: leaf.type === 'mutation' ? 'mutation' : 'query',
    summary,
    inputSchema,
    tags,
    searchBlob: [leaf.path, summary, ...tags, ...schemaKeys].filter(Boolean).join(' '),
    // Emitted at the tail and only when true, in a fixed order, so the dump's
    // byte-for-byte check stays deterministic for every other row.
    ...(admin ? { admin: true } : {}),
    ...(debug ? { debug: true } : {}),
  };
}

/**
 * Filters the leaves down to the exported catalog: every query and mutation
 * whose path is not internal-only (see {@link isDenylistedPath}). Subscriptions
 * are never exported. Rows whose summary is provided keep it byte-for-byte; the
 * rest come back as `missing` for LLM generation.
 *
 * Drift guard: an enumeration that exposes no mutation procedure throws instead
 * of emitting a query-only catalog in silence. Mutations without a committed
 * summary are legitimate `missing` entries that the dump generates before it
 * writes, so the guard counts exposed mutation leaves, not emitted rows. A
 * router refactor that stops exposing mutations, or a top-level segment renamed
 * into an internal prefix, must fail the dump rather than quietly remove write
 * support from every MCP client.
 */
export function buildCatalogRows(
  leaves: CatalogLeaf[],
  summaries: Map<string, string> = new Map()
): { rows: CatalogRow[]; missing: CatalogLeaf[] } {
  let exposedMutations = 0;
  // Resolved once for the whole catalog: the guard marker is decided from each
  // procedure's own extracted source, never the whole router file.
  const topLevelFiles = extractTopLevelRouterFiles();
  const rows: CatalogRow[] = [];
  const missing: CatalogLeaf[] = [];
  for (const leaf of leaves) {
    if (leaf.type !== 'query' && leaf.type !== 'mutation') continue;
    if (isDenylistedPath(leaf.path)) continue;
    if (leaf.type === 'mutation') exposedMutations += 1;
    const summary = summaries.get(leaf.path);
    if (typeof summary === 'string' && summary !== '') {
      // An extraction miss counts as non-admin: never hide an endpoint by accident.
      const admin = procedureRequiresAdmin(
        extractProcedureSource(leaf.path, topLevelFiles)?.source ?? null
      );
      // The debug mark comes from the leaf's own top-level segment, so it never
      // depends on static extraction succeeding.
      const debug = leaf.path.split('.')[0] === 'debug';
      rows.push(shapeRow(leaf, summary, admin, debug));
    } else {
      missing.push(leaf);
    }
  }
  if (rows.length === 0 && missing.length === 0) {
    throw new Error(
      'Catalog enumeration produced zero catalog rows — refusing to emit an empty catalog'
    );
  }
  if (exposedMutations === 0) {
    throw new Error(
      'Catalog enumeration exposed zero mutation procedures — refusing to emit a query-only catalog. ' +
        'Every mutation is either missing from the router or withheld as internal; ' +
        'check isDenylistedPath in apps/web/src/scripts/mcp-catalog/catalog.ts.'
    );
  }
  return { rows, missing };
}

/**
 * Reads the committed catalog and returns its summaries keyed by path.
 * Only a missing file (ENOENT) means "first generation": no committed
 * summaries exist yet. A file that exists but cannot be read or parsed
 * throws with the path — a merge conflict or a truncated write must fail
 * the dump loudly, because treating it as first generation would
 * regenerate every row via the LLM and silently overwrite all
 * author-edited summaries (requirement 5's keep-edit rule).
 */
export function readCommittedSummaries(
  catalogPath: string = CATALOG_JSON_PATH
): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return new Map();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The committed MCP catalog at ${catalogPath} exists but cannot be read (${reason}). ` +
        'Fix or remove the file before regenerating — the dump refuses to continue, ' +
        'because reading it as "no committed summaries" would discard every author edit.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The committed MCP catalog at ${catalogPath} is not valid JSON (${reason}). ` +
        'Fix or remove the file before regenerating — the dump refuses to continue, ' +
        'because reading it as "no committed summaries" would discard every author edit.'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `The committed MCP catalog at ${catalogPath} is not a JSON object keyed by procedure path. ` +
        'Fix or remove the file before regenerating — the dump refuses to continue, ' +
        'because reading it as "no committed summaries" would discard every author edit.'
    );
  }
  const summaries = new Map<string, string>();
  for (const [path, row] of Object.entries(parsed as Record<string, unknown>)) {
    const summary = (row as { summary?: unknown } | null)?.summary;
    if (typeof summary === 'string' && summary !== '') summaries.set(path, summary);
  }
  return summaries;
}

/**
 * Serializes the catalog deterministically: one object keyed by path, keys
 * sorted, row fields in a stable order, 2-space indent, trailing newline.
 */
export function buildCatalogJson(rows: CatalogRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const keyed: Record<string, CatalogRow> = {};
  for (const row of sorted) keyed[row.path] = row;
  return `${JSON.stringify(keyed, null, 2)}\n`;
}

// ── Static source extraction ────────────────────────────────────────────────
//
// The LLM summarizer needs the enclosing handler source for each procedure.
// It is extracted statically: root-router.ts imports are mapped to router
// files, procedure keys are located in those files, and the value expression
// after the key is captured with a string/comment-aware bracket scanner.
// Anything that fails to resolve falls back to the whole router file.

const SCRIPTS_DIR = join(__dirname, '..'); // apps/web/src/scripts
const SRC_DIR = join(SCRIPTS_DIR, '..'); // apps/web/src

type RouterFileMap = Map<string, string>; // top-level segment → absolute router file path

function resolveImportSpecifier(specifier: string, fromDir: string): string | null {
  const withoutQuery = specifier.split('?')[0] ?? specifier;
  let candidate: string;
  if (withoutQuery.startsWith('@/')) {
    candidate = join(SRC_DIR, withoutQuery.slice(2));
  } else if (withoutQuery.startsWith('./') || withoutQuery.startsWith('../')) {
    candidate = resolve(fromDir, withoutQuery);
  } else {
    return null;
  }
  for (const candidatePath of [candidate, `${candidate}.ts`, join(candidate, 'index.ts')]) {
    try {
      if (statSync(candidatePath).isFile()) return candidatePath;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function importedSymbols(source: string, fromDir: string): Map<string, string> {
  const symbols = new Map<string, string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    const resolved = resolveImportSpecifier(match[2]?.trim() ?? '', fromDir);
    if (!resolved) continue;
    for (const piece of (match[1] ?? '').split(',')) {
      const symbol = piece
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (symbol) symbols.set(symbol, resolved);
    }
  }
  return symbols;
}

function skipString(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === quote) return i + 1;
    i += 1;
  }
  return i;
}

function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '`') return i + 1;
    if (char === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        if (inner === '\\') {
          i += 2;
          continue;
        }
        if (inner === "'" || inner === '"') {
          i = skipString(source, i, inner);
          continue;
        }
        if (inner === '`') {
          i = skipTemplate(source, i);
          continue;
        }
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * Scans a value expression from `start` and returns the index just past its
 * end: the first top-level `,`, the closing brace of the enclosing object
 * literal, or the end of the source. Strings, template literals (including
 * `${…}` nesting) and comments are skipped so braces inside them do not
 * count.
 */
function findExpressionEnd(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const char = source[i];
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      if (newline === -1) return source.length;
      i = newline + 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      i = skipString(source, i, char);
      continue;
    }
    if (char === '`') {
      i = skipTemplate(source, i);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === '}') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (char === ',' && depth === 0) return i;
    i += 1;
  }
  return -1;
}

function valueExpressionFrom(source: string, afterColon: number): string | null {
  let start = afterColon;
  while (start < source.length && /\s/.test(source[start] ?? '')) start += 1;
  const end = findExpressionEnd(source, start);
  if (end === -1) return null;
  return source.slice(start, end).trim();
}

/**
 * Finds the value expression for an object key. When the key exists several
 * times, the first value that looks like a procedure (`.query(`/`.mutation(`
 * or a `*Procedure` chain) wins.
 */
function extractValueAfterKey(source: string, key: string): string | null {
  const keyRe = new RegExp(`(^|[,{;\\n])\\s*${escapeRegExp(key)}\\s*:`, 'g');
  let first: string | null = null;
  for (const match of source.matchAll(keyRe)) {
    const value = valueExpressionFrom(source, (match.index ?? 0) + match[0].length);
    if (value === null || value === '') continue;
    if (first === null) first = value;
    if (/rocedure|\.query\(|\.mutation\(/.test(value)) return value;
  }
  return first;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Maps each top-level `createTRPCRouter` key of root-router.ts to its file. */
export function extractTopLevelRouterFiles(
  rootRouterPath: string = ROOT_ROUTER_PATH
): RouterFileMap {
  const source = readFileSync(rootRouterPath, 'utf8');
  const symbols = importedSymbols(source, dirname(rootRouterPath));
  const bodyStart = source.indexOf('createTRPCRouter(');
  if (bodyStart === -1) return new Map();
  const openBrace = source.indexOf('{', bodyStart);
  const bodyEnd = findExpressionEnd(source, openBrace);
  const body = bodyEnd === -1 ? source.slice(openBrace) : source.slice(openBrace, bodyEnd);
  const files: RouterFileMap = new Map();
  const pairRe = /([A-Za-z0-9_$]+)\s*:\s*([A-Za-z0-9_$]+)/g;
  for (const match of body.matchAll(pairRe)) {
    const file = symbols.get(match[2] ?? '');
    if (file && !files.has(match[1] ?? '')) files.set(match[1] ?? '', file);
  }
  return files;
}

/**
 * Extracts the source of a procedure's value expression (the full
 * `protectedProcedure…query(…)` chain) for a dotted procedure path, walking
 * sub-router keys across files. Returns null when the walk cannot be resolved
 * statically; callers then fall back to the whole router file.
 */
export function extractProcedureSource(
  path: string,
  topLevelFiles: RouterFileMap
): { file: string; source: string } | null {
  const segments = path.split('.');
  const topFile = topLevelFiles.get(segments[0] ?? '');
  if (!topFile || segments.length < 2) return null;
  let currentFile = topFile;
  let source = readFileSync(currentFile, 'utf8');
  for (let depth = 1; depth < segments.length - 1; depth += 1) {
    const value = extractValueAfterKey(source, segments[depth] ?? '');
    if (value === null) return null;
    if (/^[A-Za-z0-9_$]+$/.test(value)) {
      const imported = importedSymbols(source, dirname(currentFile)).get(value);
      if (!imported) continue; // locally defined sub-router: stay in this file
      currentFile = imported;
      source = readFileSync(currentFile, 'utf8');
      continue;
    }
    if (value.startsWith('createTRPCRouter') || value.startsWith('{')) continue;
    return null;
  }
  const block = extractValueAfterKey(source, segments[segments.length - 1] ?? '');
  if (!block) return null;
  return { file: currentFile, source: block };
}

/**
 * True when a procedure's extracted value expression is guarded by an admin
 * procedure builder. The guard must head the chain (`adminProcedure.input(…)`),
 * so a base procedure that merely mentions a guard in its body is not marked;
 * a null source (extraction failure) is not admin, because hiding a non-admin
 * endpoint would be the worse mistake.
 */
export function procedureRequiresAdmin(source: string | null): boolean {
  if (source === null) return false;
  return ADMIN_GUARD_PROCEDURES.some(guard => new RegExp(`^\\s*${guard}\\b`).test(source));
}

function capContext(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n// … truncated`;
}

// ── Summary generation ──────────────────────────────────────────────────────

/**
 * One completion function: given a prompt and the batch label used in error
 * messages, return the raw model text. Injectable so tests do not spawn the
 * CLI. The default is {@link runKiloCompletion}.
 */
export type SummaryCompleter = (prompt: string, batchLabel: string) => string;

type SummaryBatch = {
  file: string;
  /** Name used in progress and failure messages. */
  label: string;
  items: Array<{ path: string; source: string }>;
  /** Whole router file, included once when any extraction in the batch failed. */
  wholeFile?: string;
};

/** Auth/CLI failures that a retry cannot fix must not be retried. */
function isNonRetryableCliFailure(detail: string): boolean {
  return /sign in|not logged in|unauthor|api key|401|403/i.test(detail);
}

/**
 * Reduce the `kilo run --format json` NDJSON stream to the assistant answer.
 *
 * Mirrors the in-repo contract in
 * `services/auto-routing-benchmark/src/kilo-events.ts`: only *completed* text
 * events count (`part.time.end` set), so in-progress streaming deltas are not
 * concatenated onto the final text. Both the nested `evt.part.*` and the
 * flattened `evt.*` shapes are accepted, because the event shape varies
 * across CLI versions. Malformed lines are skipped, never thrown on.
 */
export function parseKiloCompletion(lines: string[]): string {
  const texts: string[] = [];
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object') continue;
    const evt = event as {
      type?: unknown;
      text?: unknown;
      time?: { end?: unknown };
      part?: { type?: unknown; text?: unknown; time?: { end?: unknown } };
    };
    if (evt.type !== 'text') continue;
    const end = evt.part?.time?.end ?? evt.time?.end;
    if (end === undefined || end === null) continue;
    const text = typeof evt.part?.text === 'string' ? evt.part.text : evt.text;
    if (typeof text === 'string') texts.push(text);
  }
  return texts.join('\n');
}

/**
 * Run one summary completion through the Kilo CLI:
 * `kilo run --model <pinned> --variant <pinned> --format json`.
 *
 * The prompt arrives on stdin, so batch size is never bounded by `ARGV_MAX`.
 * The CLI runs in the OS temp directory so it does not load this repo's
 * project config or agent instructions. Its JSON event stream is reduced to
 * the concatenated completed assistant text parts.
 *
 * Never logs credentials: stdout is the model reply, stderr is only surfaced
 * (truncated) inside error messages.
 */
export function runKiloCompletion(prompt: string, batchLabel: string): string {
  const result = spawnSync(
    process.env.KILO_BIN ?? 'kilo',
    ['run', '--model', SUMMARY_MODEL, '--variant', SUMMARY_VARIANT, '--format', 'json'],
    {
      input: prompt,
      encoding: 'utf8',
      cwd: tmpdir(),
      timeout: SUMMARY_RUN_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }
  );

  const stderr = (result.stderr ?? '').trim();
  const detail = stderr.slice(-300);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new CatalogSummaryError(
      code === 'ENOENT'
        ? 'The Kilo CLI ("kilo") was not found on PATH. Install it with ' +
            '`npm install -g @kilocode/cli` and sign in with `kilo auth login`, ' +
            'or hand-write a summary for each new path in services/kilo-mcp/catalog.json ' +
            '— committed summaries are kept by the dump.'
        : `Kilo CLI failed for ${batchLabel}: ${result.error.message}`,
      { retryable: code !== 'ENOENT' }
    );
  }
  if (result.status !== 0) {
    throw new CatalogSummaryError(
      `Kilo CLI exited with ${result.status ?? 'no status'} for ${batchLabel}` +
        `${detail ? ` — ${detail}` : ''}. If the CLI is not signed in, run ` +
        '`kilo auth login`, or hand-write a summary for each new path in ' +
        'services/kilo-mcp/catalog.json — committed summaries are kept by the dump.',
      { retryable: !isNonRetryableCliFailure(detail) }
    );
  }

  const content = parseKiloCompletion((result.stdout ?? '').split('\n'));
  if (content.trim() === '') {
    throw new CatalogSummaryError(
      `Kilo CLI returned no summary completion for ${batchLabel}${detail ? ` — ${detail}` : ''}`,
      { retryable: !isNonRetryableCliFailure(detail) }
    );
  }
  return content;
}

function buildSummaryBatch(
  segment: string,
  leaves: CatalogLeaf[],
  topLevelFiles: RouterFileMap
): SummaryBatch {
  const file = topLevelFiles.get(segment) ?? ROOT_ROUTER_PATH;
  const items: SummaryBatch['items'] = [];
  let needsWholeFile = false;
  for (const leaf of leaves) {
    const extracted = extractProcedureSource(leaf.path, topLevelFiles);
    if (extracted) {
      items.push({ path: leaf.path, source: capContext(extracted.source, CONTEXT_CHAR_LIMIT) });
    } else {
      // Keep the leaf listed so the model knows the path exists in the file
      // source below; the whole file is attached as its extraction context.
      items.push({ path: leaf.path, source: '' });
      needsWholeFile = true;
    }
  }
  const wholeFile = needsWholeFile
    ? capContext(readFileSync(file, 'utf8'), FILE_CONTEXT_CHAR_LIMIT)
    : undefined;
  return { file, label: basename(file), items, wholeFile };
}

function buildSummaryPrompt(batch: SummaryBatch): string {
  const lines = [
    "You are writing summaries for an MCP tool catalog built from a web app's tRPC query and mutation procedures.",
    `For each procedure path below, ${SUMMARY_INSTRUCTION}`,
    'Respond with ONLY a JSON object mapping each procedure path to its summary string. Every listed path must appear exactly once.',
    '',
    `Source file: ${batch.file}`,
    '',
    'Procedures to summarize:',
  ];
  for (const item of batch.items) lines.push(`- ${item.path}`);
  if (batch.wholeFile) {
    lines.push('', 'Full file source (may be truncated):', '```ts', batch.wholeFile, '```');
  }
  for (const item of batch.items) {
    lines.push(
      '',
      `### ${item.path}`,
      '```ts',
      item.source || '(source not extracted; use the file source above)',
      '```'
    );
  }
  return lines.join('\n');
}

function parseSummaries(
  content: string,
  requestedPaths: string[],
  batchLabel: string
): Map<string, string> {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const candidate = start !== -1 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new CatalogSummaryError(`LLM response for ${batchLabel} is not valid JSON`, {
      retryable: false,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CatalogSummaryError(`LLM response for ${batchLabel} is not a JSON object`, {
      retryable: false,
    });
  }
  const summaries = new Map<string, string>();
  const missing: string[] = [];
  for (const path of requestedPaths) {
    const summary = (parsed as Record<string, unknown>)[path];
    if (typeof summary === 'string' && summary.trim() !== '') summaries.set(path, summary);
    else missing.push(path);
  }
  if (missing.length > 0) {
    throw new CatalogSummaryError(
      `LLM response for ${batchLabel} is missing usable summaries for: ${missing.join(', ')}`,
      { retryable: false }
    );
  }
  return summaries;
}

/**
 * Generates summaries for the given leaves, one Kilo CLI completion per router
 * file with all of that file's missing summaries batched into it. Calls `log`
 * with a progress line naming each router-file batch as it starts, so a long
 * generation shows where it is instead of going silent. Throws
 * `CatalogSummaryError` (with `retryable` set) when a batch fails. Never logs
 * credentials.
 */
export async function generateMissingSummaries(
  missing: CatalogLeaf[],
  complete: SummaryCompleter = runKiloCompletion,
  log: (message: string) => void = () => {}
): Promise<Map<string, string>> {
  if (missing.length === 0) return new Map();
  const topLevelFiles = extractTopLevelRouterFiles();
  const bySegment = new Map<string, CatalogLeaf[]>();
  for (const leaf of missing) {
    const segment = leaf.path.split('.')[0] ?? '';
    const group = bySegment.get(segment);
    if (group) group.push(leaf);
    else bySegment.set(segment, [leaf]);
  }
  const generated = new Map<string, string>();
  const batches = [...bySegment.entries()];
  for (const [batchIndex, [segment, leaves]] of batches.entries()) {
    const batch = buildSummaryBatch(segment, leaves, topLevelFiles);
    log(
      `  batch ${batchIndex + 1}/${batches.length} ${batch.label}: generating ${leaves.length} ${leaves.length === 1 ? 'summary' : 'summaries'}…`
    );
    const prompt = buildSummaryPrompt(batch);
    const content = complete(prompt, batch.label);
    const summaries = parseSummaries(
      content,
      leaves.map(leaf => leaf.path),
      batch.label
    );
    for (const [path, summary] of summaries) generated.set(path, summary);
  }
  return generated;
}
