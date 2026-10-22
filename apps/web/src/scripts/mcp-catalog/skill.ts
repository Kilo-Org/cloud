/**
 * Generator for the Kilo MCP agent skill, `.kilo/skills/kilo-mcp/SKILL.md`.
 *
 * The skill is derived from the committed `services/kilo-mcp/catalog.json` —
 * never hand-maintained — so it can never fall behind the catalog. The
 * how-to prose lives in the hand-edited template beside this file; the catalog
 * supplies the census: the sorted list of first path segments, one bullet per
 * area. The census stays a map, not a copy of the catalog: it carries area
 * names only, never a count, a summary, a tag list or a procedure path. That
 * also keeps two concurrent pull requests byte-identical when both only add
 * procedures inside existing areas, so the generated file cannot conflict. The
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

/**
 * Hard ceiling for the generated file. The skill teaches how to use the MCP
 * and shows where the areas are; it must never grow into a dump of the
 * catalog. An agent that needs a summary, a tag or a path runs `kilo_search`.
 */
export const SKILL_BYTE_LIMIT = 8_000;

/** Substituted by the census block; the template must contain it exactly once. */
const CENSUS_TOKEN = '{{CENSUS}}';

/**
 * The distinct first path segments, sorted alphabetically. The census derives
 * nothing else: a count or a size ordering would change the rendered skill on
 * almost every catalog edit, so two concurrent pull requests would conflict on
 * this file. A path's summary and tags stay in the catalog, where `kilo_search`
 * reads them.
 */
export function censusAreas(paths: string[]): string[] {
  const areas = new Set<string>();
  for (const path of paths) areas.add(path.split('.')[0] ?? path);
  return [...areas].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Renders the census block that replaces `{{CENSUS}}` in the template: one
 * bullet per area, so a new area adds one line instead of rewriting the block.
 */
export function renderCensus(paths: string[]): string {
  return censusAreas(paths)
    .map(area => `- \`${area}\``)
    .join('\n');
}

function parseCatalogPaths(catalogJsonText: string, catalogPath: string): string[] {
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
  const paths = Object.keys(parsed as Record<string, unknown>);
  if (paths.length === 0) {
    throw new Error(
      `The MCP catalog at ${catalogPath} has zero rows — refusing to emit an empty skill. ` +
        'The catalog is the source of truth for this skill; restore its rows before regenerating.'
    );
  }
  return paths;
}

/**
 * Reads the committed catalog and lifts out its procedure paths. Every failure
 * — missing, unreadable, invalid JSON, non-object or zero rows — throws naming
 * the catalog path, because the catalog is the source of truth and an empty
 * skill would be a lie.
 */
export function readCatalogPaths(catalogPath: string = CATALOG_JSON_PATH): string[] {
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
  return parseCatalogPaths(raw, catalogPath);
}

function renderSkillFromPaths(paths: string[], template: string): string {
  if (!template.includes(CENSUS_TOKEN)) {
    throw new Error(
      `The skill template at ${SKILL_TEMPLATE_PATH} does not contain the ${CENSUS_TOKEN} token. ` +
        'Add it where the generated census belongs — the generator has nowhere to put the census without it.'
    );
  }
  return template.replace(CENSUS_TOKEN, () => renderCensus(paths));
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
  return renderSkillFromPaths(parseCatalogPaths(json, CATALOG_JSON_PATH), template);
}

/** Reads the catalog from disk and renders the full skill file. */
export function buildSkillFromCatalog(catalogPath: string = CATALOG_JSON_PATH): string {
  return renderSkillFromPaths(
    readCatalogPaths(catalogPath),
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
