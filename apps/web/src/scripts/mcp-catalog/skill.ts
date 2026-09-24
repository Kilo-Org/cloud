/**
 * Generator for the Kilo MCP agent skill, `.kilo/skills/kilo-mcp/SKILL.md`.
 *
 * The skill is derived from the committed `services/kilo-mcp/catalog.json` —
 * never hand-maintained — so it can never fall behind the catalog. The
 * how-to prose lives in the hand-edited template beside this file; the catalog
 * supplies the census (prefix table, glosses, key terms and sub-areas). The
 * same catalog always yields the same bytes: no timestamp, commit sha, random
 * value or inlined procedure path enters the output.
 *
 * Usage (from apps/web):
 *   pnpm script src/scripts/mcp-catalog/skill.ts              # write or regenerate
 *   pnpm script src/scripts/mcp-catalog/skill.ts -- --check    # exit 0 iff regenerating is byte-identical
 *
 * The catalog is the source of truth for this skill. A missing, unreadable,
 * invalid or empty catalog fails the generator instead of emitting a skill with
 * an invented or partial map.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CATALOG_JSON_PATH } from './catalog';

/** Repository root: five levels above apps/web/src/scripts/mcp-catalog. */
export const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/** Absolute path of the generated skill committed to the repository. */
export const SKILL_MD_PATH = join(REPO_ROOT, '.kilo', 'skills', 'kilo-mcp', 'SKILL.md');

/**
 * Repo-relative display form of the skill path for CLI output, stable across
 * checkouts and matching how docs and CI refer to the file.
 */
export const SKILL_MD_DISPLAY_PATH = '.kilo/skills/kilo-mcp/SKILL.md';

/** The hand-edited prose template. Humans edit this; nobody edits the skill. */
export const SKILL_TEMPLATE_PATH = join(__dirname, 'skill-template.md');

/** Hard ceiling for the generated file: it must stay a usable map. */
export const SKILL_BYTE_LIMIT = 40_000;

/** Word-boundary cap for a prefix gloss taken from a catalog summary. */
const GLOSS_CHAR_LIMIT = 180;

/** Number of key terms rendered per prefix. */
const KEY_TERM_LIMIT = 6;

/** Substituted by the census block; the template must contain it exactly once. */
const CENSUS_TOKEN = '{{CENSUS}}';

/**
 * The subset of a catalog row the census reads. The catalog is an object keyed
 * by procedure path; `readCatalogRows` lifts each entry into this shape.
 */
export type SkillCatalogRow = {
  path: string;
  kind: string;
  summary: string;
  tags: string[];
};

/** One sub-area bucket of a prefix: a second path segment or the direct bucket. */
export type CensusSubArea = {
  /** `organizations.kiloclaw`, or the prefix itself for the direct bucket. */
  label: string;
  total: number;
  queries: number;
  mutations: number;
};

/** One prefix of the catalog census. */
export type CensusPrefix = {
  name: string;
  total: number;
  queries: number;
  mutations: number;
  /** Escaped first sentence of the root row's summary, or `—`. */
  gloss: string;
  /** Up to six escaped key terms, comma-joined, or `—`. */
  keyTerms: string;
  /** Buckets, sorted; empty when the prefix has fewer than two of them. */
  subAreas: CensusSubArea[];
};

/** The whole generated map: totals plus one entry per prefix. */
export type Census = {
  total: number;
  queries: number;
  mutations: number;
  prefixes: CensusPrefix[];
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * True when the `.` at `index` closes a single-letter abbreviation — the last
 * period of `e.g.`, `i.e.`, `U.S.`. The period is preceded by a single letter
 * that is itself preceded by a period (`<letter>.`), the shape a chain of
 * one-letter tokens joined by periods leaves. A summary's first sentence must
 * not end there, because the text up to the period would be a dangling
 * fragment, not a sentence.
 */
function closesSingleLetterAbbreviation(text: string, index: number): boolean {
  const before = text[index - 1];
  if (before === undefined || !/[A-Za-z]/.test(before)) return false;
  return index >= 2 && text[index - 2] === '.';
}

/**
 * First sentence of a summary: up to and including the first `.`, `!` or `?`
 * that is followed by whitespace or the end of the string. A `.` closing a
 * single-letter abbreviation (`e.g.`, `i.e.`) never ends the sentence — the
 * split would otherwise cut mid-abbreviation and leave a fragment. Whitespace
 * is collapsed first, so a newline-terminated line ends the sentence too.
 */
function firstSentence(summary: string): string {
  const text = collapseWhitespace(summary);
  if (text === '') return '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (
      (char === '.' || char === '!' || char === '?') &&
      (i === text.length - 1 || text[i + 1] === ' ')
    ) {
      if (char === '.' && closesSingleLetterAbbreviation(text, i)) continue;
      return text.slice(0, i + 1);
    }
  }
  return text;
}

/** Trim to the last word boundary at or before `limit`, appending `…` when cut. */
function capAtWordBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return `${cut}…`;
}

/** A table cell can never carry a raw pipe, or it would split its own row. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * A prefix gloss, derived from a catalog summary. A blank summary renders `—`
 * and invents nothing: an absent gloss beats a fabricated one.
 */
function renderGloss(summary: string): string {
  const sentence = capAtWordBoundary(firstSentence(summary), GLOSS_CHAR_LIMIT);
  return sentence === '' ? '—' : escapeCell(sentence);
}

/** The prefix's shortest path; ties are broken alphabetically. */
function rootRow(prefixRows: SkillCatalogRow[]): SkillCatalogRow | undefined {
  let root: SkillCatalogRow | undefined;
  for (const row of prefixRows) {
    if (
      root === undefined ||
      row.path.split('.').length < root.path.split('.').length ||
      (row.path.split('.').length === root.path.split('.').length && row.path < root.path)
    ) {
      root = row;
    }
  }
  return root;
}

/**
 * Key terms for a prefix: its rows' tags that also occur as a lowercase path
 * segment below the prefix, minus the prefix's own lowercase name. Input-schema
 * tags such as `organizationid` never qualify because they are not segments.
 * Sorted by count descending then name ascending; the top six are rendered,
 * comma-joined. `—` when none qualify.
 */
function renderKeyTerms(prefix: string, prefixRows: SkillCatalogRow[]): string {
  const segments = new Set<string>();
  for (const row of prefixRows) {
    const parts = row.path.split('.');
    for (let i = 1; i < parts.length; i += 1) {
      const part = parts[i];
      if (part) segments.add(part.toLowerCase());
    }
  }
  const counts = new Map<string, number>();
  for (const row of prefixRows) {
    for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const prefixName = prefix.toLowerCase();
  const terms = [...counts.entries()]
    .filter(([tag]) => tag !== prefixName && segments.has(tag))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, KEY_TERM_LIMIT)
    .map(([tag]) => tag);
  return terms.length === 0 ? '—' : escapeCell(terms.join(', '));
}

/**
 * Sub-area buckets: the second path segment, plus a direct bucket named after
 * the prefix for paths with at most two segments. Emitted only when the prefix
 * has at least two distinct buckets; rows sorted count desc then name asc.
 */
function buildSubAreas(prefix: string, prefixRows: SkillCatalogRow[]): CensusSubArea[] {
  const buckets = new Map<string, { total: number; queries: number; mutations: number }>();
  for (const row of prefixRows) {
    const parts = row.path.split('.');
    const label = parts.length <= 2 ? prefix : `${prefix}.${parts[1] ?? ''}`;
    const bucket = buckets.get(label) ?? { total: 0, queries: 0, mutations: 0 };
    bucket.total += 1;
    if (row.kind === 'mutation') bucket.mutations += 1;
    else bucket.queries += 1;
    buckets.set(label, bucket);
  }
  if (buckets.size < 2) return [];
  return [...buckets.entries()]
    .map(([label, counts]) => ({ label, ...counts }))
    .sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/**
 * Builds the census from catalog rows. Prefix = first path segment. Prefixes
 * are ordered total descending then name ascending; each carries its totals,
 * its gloss, its key terms and — when it has two or more buckets — its
 * sub-areas. Deterministic for any input order.
 */
export function censusCatalog(rows: SkillCatalogRow[]): Census {
  const byPrefix = new Map<string, SkillCatalogRow[]>();
  for (const row of rows) {
    const prefix = row.path.split('.')[0] ?? row.path;
    const group = byPrefix.get(prefix);
    if (group) group.push(row);
    else byPrefix.set(prefix, [row]);
  }
  const prefixes: CensusPrefix[] = [];
  let total = 0;
  let queries = 0;
  let mutations = 0;
  for (const [name, prefixRows] of byPrefix) {
    let prefixQueries = 0;
    let prefixMutations = 0;
    for (const row of prefixRows) {
      if (row.kind === 'mutation') prefixMutations += 1;
      else prefixQueries += 1;
    }
    total += prefixRows.length;
    queries += prefixQueries;
    mutations += prefixMutations;
    prefixes.push({
      name,
      total: prefixRows.length,
      queries: prefixQueries,
      mutations: prefixMutations,
      gloss: renderGloss(rootRow(prefixRows)?.summary ?? ''),
      keyTerms: renderKeyTerms(name, prefixRows),
      subAreas: buildSubAreas(name, prefixRows),
    });
  }
  prefixes.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { total, queries, mutations, prefixes };
}

/** Renders the census block that replaces `{{CENSUS}}` in the template. */
export function renderCensus(census: Census): string {
  const lines: string[] = [
    `The catalog holds **${census.total} procedures** — **${census.queries} queries** and **${census.mutations} mutations** — under **${census.prefixes.length} prefixes**.`,
    '',
    '| Prefix | Procedures | Queries | Mutations | Gloss (from catalog `summary`) | Key terms (from catalog `tags`) |',
    '|---|---:|---:|---:|---|---|',
  ];
  for (const prefix of census.prefixes) {
    lines.push(
      `| \`${prefix.name}\` | ${prefix.total} | ${prefix.queries} | ${prefix.mutations} | ${prefix.gloss} | ${prefix.keyTerms} |`
    );
  }
  const withSubAreas = census.prefixes.filter(prefix => prefix.subAreas.length > 0);
  if (withSubAreas.length > 0) {
    lines.push('', '### Sub-areas');
    for (const prefix of withSubAreas) {
      lines.push(
        `#### \`${prefix.name}.*\` — ${prefix.total} procedures (${prefix.queries} queries, ${prefix.mutations} mutations)`,
        '',
        '| Sub-area | Procedures | Queries | Mutations |',
        '|---|---:|---:|---:|'
      );
      for (const subArea of prefix.subAreas) {
        lines.push(
          `| \`${subArea.label}\` | ${subArea.total} | ${subArea.queries} | ${subArea.mutations} |`
        );
      }
      lines.push('');
    }
    lines.pop();
  }
  return lines.join('\n');
}

function parseCatalogRows(catalogJsonText: string, catalogPath: string): SkillCatalogRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(catalogJsonText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The MCP catalog at ${catalogPath} is not valid JSON (${reason}). ` +
        'The catalog is the source of truth for this skill — fix or restore it before regenerating, ' +
        'because the generator refuses to emit a skill from an unreadable catalog.'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `The MCP catalog at ${catalogPath} is not a JSON object keyed by procedure path. ` +
        'The catalog is the source of truth for this skill — fix or restore it before regenerating.'
    );
  }
  const rows: SkillCatalogRow[] = [];
  for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
    const row = value as { kind?: unknown; summary?: unknown; tags?: unknown } | null | undefined;
    rows.push({
      path,
      kind: typeof row?.kind === 'string' ? row.kind : 'query',
      summary: typeof row?.summary === 'string' ? row.summary : '',
      tags: Array.isArray(row?.tags)
        ? row.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
    });
  }
  if (rows.length === 0) {
    throw new Error(
      `The MCP catalog at ${catalogPath} has zero rows — refusing to emit an empty skill. ` +
        'The catalog is the source of truth for this skill; restore its rows before regenerating.'
    );
  }
  return rows;
}

/**
 * Reads the committed catalog and lifts it into census rows. Every failure —
 * missing, unreadable, invalid JSON, non-object or zero rows — throws naming
 * the catalog path, because the catalog is the source of truth and an empty
 * skill would be a lie.
 */
export function readCatalogRows(catalogPath: string = CATALOG_JSON_PATH): SkillCatalogRow[] {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The MCP catalog at ${catalogPath} cannot be read (${reason}). ` +
        'The catalog is the source of truth for this skill — fix or restore it before regenerating.'
    );
  }
  return parseCatalogRows(raw, catalogPath);
}

function renderSkillFromCensus(census: Census, template: string): string {
  if (!template.includes(CENSUS_TOKEN)) {
    throw new Error(
      `The skill template at ${SKILL_TEMPLATE_PATH} does not contain the ${CENSUS_TOKEN} token. ` +
        'Add it where the generated census belongs — the generator has nowhere to put the census without it.'
    );
  }
  return template.replace(CENSUS_TOKEN, renderCensus(census));
}

/**
 * Renders the skill from catalog JSON text and the template. Substitutes the
 * single `{{CENSUS}}` token; throws when the template does not contain it.
 */
export function renderSkill(
  catalogJsonText: string | Buffer,
  template: string = readFileSync(SKILL_TEMPLATE_PATH, 'utf8')
): string {
  const json =
    typeof catalogJsonText === 'string' ? catalogJsonText : catalogJsonText.toString('utf8');
  const rows = parseCatalogRows(json, CATALOG_JSON_PATH);
  return renderSkillFromCensus(censusCatalog(rows), template);
}

/** Reads the catalog from disk and renders the full skill file. */
export function buildSkillFromCatalog(catalogPath: string = CATALOG_JSON_PATH): string {
  return renderSkillFromCensus(
    censusCatalog(readCatalogRows(catalogPath)),
    readFileSync(SKILL_TEMPLATE_PATH, 'utf8')
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');

  const skill = buildSkillFromCatalog();

  if (check) {
    if (!existsSync(SKILL_MD_PATH)) {
      console.error(
        `❌ ${SKILL_MD_DISPLAY_PATH} is stale: regenerating from services/kilo-mcp/catalog.json produces a different file`
      );
      console.error('   Run: pnpm --filter web script src/scripts/mcp-catalog/skill.ts');
      process.exit(1);
    }
    const onDisk = readFileSync(SKILL_MD_PATH, 'utf8');
    if (onDisk === skill) {
      console.log(`✅ ${SKILL_MD_DISPLAY_PATH} is up to date (${Buffer.byteLength(skill)} bytes)`);
      return;
    }
    console.error(
      `❌ ${SKILL_MD_DISPLAY_PATH} is stale: regenerating from services/kilo-mcp/catalog.json produces a different file`
    );
    console.error('   Run: pnpm --filter web script src/scripts/mcp-catalog/skill.ts');
    process.exit(1);
  }

  mkdirSync(dirname(SKILL_MD_PATH), { recursive: true });
  writeFileSync(SKILL_MD_PATH, skill);
  console.log(`✅ wrote ${SKILL_MD_DISPLAY_PATH} (${Buffer.byteLength(skill)} bytes)`);
}

// Only run the CLI when this file is the entry point, so importing the library
// (for example from skill.test.ts) never writes the skill as a side effect.
if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error('❌', error.message);
      if (error.stack) console.error(error.stack);
    } else {
      console.error('❌', error);
    }
    process.exit(1);
  });
}
