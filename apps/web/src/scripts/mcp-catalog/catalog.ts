/**
 * Library for the Kilo MCP tRPC query catalog dump.
 *
 * Enumerates every procedure from the live `rootRouter` (never a hand-written
 * list), shapes deterministic catalog rows, preserves author-edited summaries
 * from the committed `services/kilo-mcp/catalog.json`, and generates missing
 * summaries via an LLM (OpenRouter or Anthropic, plain fetch). Summaries are
 * never generated at MCP runtime: the committed catalog is the only runtime
 * artifact, and authors edit its summaries by hand. See dump.ts for the CLI
 * entry point.
 */
import { readFileSync, statSync } from 'node:fs';
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
 * Top-level router segments that stay internal-only. This is a denylist:
 * every other query procedure is exported, individual procedures cannot opt
 * back in, and mutations are never exported.
 */
export const DENYLISTED_TOP_LEVEL_SEGMENTS = ['admin', 'debug', 'test'] as const;

/** Instruction every generated summary must follow. */
export const SUMMARY_INSTRUCTION =
  'Write a 1-2 sentence search-friendly summary of what this call does, in words an agent would type to find it. No implementation detail. Not a restatement of the path.';

const CONTEXT_CHAR_LIMIT = 4_000;
const FILE_CONTEXT_CHAR_LIMIT = 60_000;
const SUMMARY_COMPLETION_TOKENS = 8_192;
const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';

export type CatalogLeaf = {
  path: string;
  type: string;
  /** First Zod input schema of the procedure, or undefined when it takes none. */
  firstInput: unknown;
};

export type CatalogRow = {
  path: string;
  kind: 'query';
  summary: string;
  inputSchema: Record<string, unknown>;
  tags: string[];
  searchBlob: string;
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
      firstInput: inputs[0],
    });
  }
  if (leaves.length === 0) {
    throw new Error('rootRouter exposed zero procedures — cannot enumerate the catalog');
  }
  return leaves;
}

function toInputSchema(firstInput: unknown): Record<string, unknown> {
  if (!firstInput) return {};
  // `io: 'input'` keeps the schema faithful for callers that build a request;
  // `unrepresentable: 'any'` keeps rare schemas (z.any(), z.date(), …) from
  // failing the whole dump.
  return z.toJSONSchema(firstInput as z.ZodType, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}

function topSchemaKeys(inputSchema: Record<string, unknown>): string[] {
  const properties = inputSchema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
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

function shapeRow(leaf: CatalogLeaf, summary: string): CatalogRow {
  const segments = leaf.path.split('.');
  const inputSchema = toInputSchema(leaf.firstInput);
  const schemaKeys = topSchemaKeys(inputSchema);
  const tags = deriveTags(segments, schemaKeys);
  return {
    path: leaf.path,
    kind: 'query',
    summary,
    inputSchema,
    tags,
    searchBlob: [leaf.path, summary, ...tags, ...schemaKeys].filter(Boolean).join(' '),
  };
}

/**
 * Filters the leaves down to the exported catalog: queries only, denylisted
 * top-level segments dropped. Rows whose summary is provided keep it
 * byte-for-byte; the rest come back as `missing` for LLM generation.
 */
export function buildCatalogRows(
  leaves: CatalogLeaf[],
  summaries: Map<string, string> = new Map()
): { rows: CatalogRow[]; missing: CatalogLeaf[] } {
  const denylisted = new Set<string>(DENYLISTED_TOP_LEVEL_SEGMENTS);
  const rows: CatalogRow[] = [];
  const missing: CatalogLeaf[] = [];
  for (const leaf of leaves) {
    if (leaf.type !== 'query') continue;
    if (denylisted.has(leaf.path.split('.')[0] ?? '')) continue;
    const summary = summaries.get(leaf.path);
    if (typeof summary === 'string' && summary !== '') {
      rows.push(shapeRow(leaf, summary));
    } else {
      missing.push(leaf);
    }
  }
  if (rows.length === 0 && missing.length === 0) {
    throw new Error(
      'Catalog enumeration produced zero query rows — refusing to emit an empty catalog'
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

function capContext(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n// … truncated`;
}

// ── LLM summary generation ──────────────────────────────────────────────────

type LlmProvider = { name: 'openrouter' | 'anthropic'; apiKey: string; model: string };

type SummaryBatch = {
  file: string;
  /** Name used in progress and failure messages. */
  label: string;
  items: Array<{ path: string; source: string }>;
  /** Whole router file, included once when any extraction in the batch failed. */
  wholeFile?: string;
};

function resolveLlmProvider(): LlmProvider | null {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) return { name: 'openrouter', apiKey: openrouterKey, model: OPENROUTER_MODEL };
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) return { name: 'anthropic', apiKey: anthropicKey, model: ANTHROPIC_MODEL };
  return null;
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
    "You are writing summaries for an MCP tool catalog built from a web app's tRPC query procedures.",
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

async function requestSummaryCompletion(
  provider: LlmProvider,
  prompt: string,
  batchLabel: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const isAnthropic = provider.name === 'anthropic';
  const headers: Record<string, string> = isAnthropic
    ? {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      }
    : {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
      };
  const messages = [{ role: 'user', content: prompt }];
  const body = isAnthropic
    ? { model: provider.model, max_tokens: SUMMARY_COMPLETION_TOKENS, temperature: 0, messages }
    : { model: provider.model, max_tokens: SUMMARY_COMPLETION_TOKENS, temperature: 0, messages };

  let response: Response;
  try {
    response = await fetchImpl(
      isAnthropic ? ANTHROPIC_MESSAGES_URL : OPENROUTER_CHAT_COMPLETIONS_URL,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }
    );
  } catch (error) {
    throw new CatalogSummaryError(
      `LLM request for ${batchLabel} failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new CatalogSummaryError(
      `Summary generation failed for ${batchLabel}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
      // A rejected key will never succeed on retry; transient statuses might.
      { retryable: response.status !== 401 && response.status !== 403 }
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    content?: Array<{ text?: string }>;
  } | null;
  if (!payload) {
    throw new CatalogSummaryError(`LLM response for ${batchLabel} is not valid JSON`, {
      retryable: true,
    });
  }
  const content = isAnthropic
    ? (payload.content ?? []).map(part => part.text ?? '').join('')
    : (payload.choices?.[0]?.message?.content ?? '');
  if (!content.trim()) {
    throw new CatalogSummaryError(`LLM returned an empty completion for ${batchLabel}`, {
      retryable: true,
    });
  }
  return content;
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
 * Generates summaries for the given leaves, one chat completion per router
 * file with all of that file's missing summaries batched into it. Calls
 * `log` with a progress line naming each router-file batch as it starts, so
 * a long generation shows where it is instead of going silent. Throws
 * `CatalogSummaryError` (with `retryable` set) when a batch fails. Never logs
 * credentials.
 */
export async function generateMissingSummaries(
  missing: CatalogLeaf[],
  fetchImpl: typeof fetch = fetch,
  log: (message: string) => void = () => {}
): Promise<Map<string, string>> {
  if (missing.length === 0) return new Map();
  const provider = resolveLlmProvider();
  if (!provider) {
    throw new CatalogSummaryError(
      'No LLM credentials configured: set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) so the missing summaries can be generated, or hand-write a summary for each new path in services/kilo-mcp/catalog.json — committed summaries are kept by the dump. Summaries are never generated at MCP runtime, and an incomplete catalog is never written.',
      { retryable: false }
    );
  }
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
    const content = await requestSummaryCompletion(provider, prompt, batch.label, fetchImpl);
    const summaries = parseSummaries(
      content,
      leaves.map(leaf => leaf.path),
      batch.label
    );
    for (const [path, summary] of summaries) generated.set(path, summary);
  }
  return generated;
}
