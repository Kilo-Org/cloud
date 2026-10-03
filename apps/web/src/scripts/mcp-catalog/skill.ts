/**
 * Generator for the Kilo MCP agent skill, `.kilo/skills/kilo-mcp/SKILL.md`.
 *
 * The skill is derived from the committed `services/kilo-mcp/catalog.json` —
 * never hand-maintained — so it can never fall behind the catalog. The
 * how-to prose lives in the hand-edited template beside this file; the catalog
 * supplies the census (the prefix table and the sub-area lists). The census
 * stays a map, not a copy of the catalog: it carries counts only, never a
 * summary, a tag list or a procedure path. The same catalog always yields the
 * same bytes: no timestamp, commit sha, random value or inlined procedure path
 * enters the output.
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

/**
 * Hard ceiling for the generated file. The skill teaches how to use the MCP
 * and shows where the areas are; it must never grow into a dump of the
 * catalog. An agent that needs a summary, a tag or a path runs `kilo_search`.
 */
export const SKILL_BYTE_LIMIT = 8_000;

/** Substituted by the census block; the template must contain it exactly once. */
const CENSUS_TOKEN = '{{CENSUS}}';

/**
 * The subset of a catalog row the census reads. The catalog is an object keyed
 * by procedure path; `readCatalogRows` lifts each entry into this shape. The
 * census needs nothing else — a row's summary and tags stay in the catalog,
 * where `kilo_search` reads them.
 */
export type SkillCatalogRow = {
  path: string;
  kind: string;
};

/** One sub-area bucket of a prefix: a second path segment or the direct bucket. */
export type CensusSubArea = {
  /** `organizations.kiloclaw`, or the prefix itself for the direct bucket. */
  label: string;
  total: number;
};

/** One prefix of the catalog census. */
export type CensusPrefix = {
  name: string;
  total: number;
  queries: number;
  mutations: number;
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

/**
 * Sub-area buckets: the second path segment, plus a direct bucket named after
 * the prefix for paths with at most two segments. Emitted only when the prefix
 * has at least two distinct buckets; rows sorted count desc then name asc.
 */
function buildSubAreas(prefix: string, prefixRows: SkillCatalogRow[]): CensusSubArea[] {
  const counts = new Map<string, number>();
  for (const row of prefixRows) {
    const parts = row.path.split('.');
    const label = parts.length <= 2 ? prefix : `${prefix}.${parts[1] ?? ''}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size < 2) return [];
  return [...counts.entries()]
    .map(([label, total]) => ({ label, total }))
    .sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/**
 * Builds the census from catalog rows. Prefix = first path segment. Prefixes
 * are ordered total descending then name ascending; each carries its totals
 * and — when it has two or more buckets — its sub-areas. Deterministic for any
 * input order.
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
      subAreas: buildSubAreas(name, prefixRows),
    });
  }
  prefixes.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { total, queries, mutations, prefixes };
}

/** Renders the census block that replaces `{{CENSUS}}` in the template. */
export function renderCensus(census: Census): string {
  const lines: string[] = [
    `**${census.total} procedures** — **${census.queries} queries**, **${census.mutations} mutations** — under **${census.prefixes.length} prefixes**.`,
    '',
    '| Prefix | Procedures | Queries | Mutations |',
    '|---|---:|---:|---:|',
  ];
  for (const prefix of census.prefixes) {
    // A raw pipe in a path key would split its own table row.
    const name = prefix.name.replace(/\|/g, '\\|');
    lines.push(`| \`${name}\` | ${prefix.total} | ${prefix.queries} | ${prefix.mutations} |`);
  }
  const withSubAreas = census.prefixes.filter(prefix => prefix.subAreas.length > 0);
  if (withSubAreas.length > 0) {
    lines.push(
      '',
      '### Sub-areas',
      '',
      'The second path segment of each area that splits, with procedure counts:'
    );
    for (const prefix of withSubAreas) {
      const buckets = prefix.subAreas
        .map(subArea => {
          // The line is already scoped to the prefix, so name the second
          // segment only. The direct bucket has no second segment.
          const segment =
            subArea.label === prefix.name
              ? '(direct)'
              : subArea.label.slice(prefix.name.length + 1);
          return `\`${segment}\` ${subArea.total}`;
        })
        .join(', ');
      lines.push('', `- \`${prefix.name}.*\` — ${prefix.total}: ${buckets}`);
    }
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
    const row = value as { kind?: unknown } | null | undefined;
    rows.push({ path, kind: typeof row?.kind === 'string' ? row.kind : 'query' });
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
  return template.replace(CENSUS_TOKEN, () => renderCensus(census));
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
