/**
 * Unit tests for the Kilo MCP skill generator (src/scripts/mcp-catalog/skill).
 *
 * Most tests use a fixture catalog object, so they exercise the census rules
 * without the 1.36 MB committed catalog. The last block proves the committed
 * `.kilo/skills/kilo-mcp/SKILL.md` is byte-for-byte what the generator produces
 * from the committed catalog, so a hand edit fails here.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CATALOG_JSON_PATH } from './catalog';
import {
  SKILL_BYTE_LIMIT,
  SKILL_MD_PATH,
  censusCatalog,
  readCatalogRows,
  renderCensus,
  renderSkill,
  type SkillCatalogRow,
} from './skill';

const fixtureRow = (path: string, kind: string): SkillCatalogRow => ({ path, kind });

/**
 * A real catalog row also carries a summary and tags. The fixtures carry
 * sentinels for both, so a test can prove the census leaves them in the catalog
 * where `kilo_search` reads them, instead of copying them into the skill.
 */
const SENTINEL_SUMMARY = 'Sentinel summary that must never reach the skill.';
const SENTINEL_TAG = 'sentineltag';

/** The catalog on disk is an object keyed by path; mirror that shape. */
const catalogJson = (rows: SkillCatalogRow[]): string =>
  JSON.stringify(
    Object.fromEntries(
      rows.map(row => [
        row.path,
        { kind: row.kind, summary: SENTINEL_SUMMARY, tags: [SENTINEL_TAG] },
      ])
    )
  );

/** Minimal template: the census block plus a marker before it. */
const TEMPLATE = 'HEADER\n\n{{CENSUS}}\n';

/** Split a markdown row on unescaped pipes and drop the outer empty cells. */
function cells(line: string): string[] {
  const result: string[] = [];
  let buffer = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') {
      buffer += '\\|';
      i += 1;
      continue;
    }
    if (char === '|') {
      result.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  result.push(buffer);
  if (result.length >= 2 && result[0]?.trim() === '') result.shift();
  if (result.length >= 1 && result[result.length - 1]?.trim() === '') result.pop();
  return result;
}

const isSeparatorRow = (line: string): boolean => {
  const trimmed = line.trim();
  return /\|/.test(trimmed) && /-/.test(trimmed) && /^[\s|:-]+$/.test(trimmed);
};

describe('mcp-catalog skill', () => {
  describe('censusCatalog', () => {
    it('counts totals and the per-prefix query/mutation split', () => {
      const census = censusCatalog([
        fixtureRow('alpha.a', 'query'),
        fixtureRow('alpha.b', 'mutation'),
        fixtureRow('beta.c', 'query'),
      ]);
      expect(census.total).toBe(3);
      expect(census.queries).toBe(2);
      expect(census.mutations).toBe(1);
      const alpha = census.prefixes.find(prefix => prefix.name === 'alpha');
      expect(alpha).toMatchObject({ total: 2, queries: 1, mutations: 1 });
      const beta = census.prefixes.find(prefix => prefix.name === 'beta');
      expect(beta).toMatchObject({ total: 1, queries: 1, mutations: 0 });
    });

    it('orders prefixes by total descending then name ascending', () => {
      const census = censusCatalog([
        fixtureRow('a.x', 'query'),
        fixtureRow('a.y', 'query'),
        fixtureRow('b.z', 'query'),
        fixtureRow('c.w', 'query'),
        fixtureRow('c.v', 'query'),
        fixtureRow('d.q', 'query'),
      ]);
      // a and c tie at 2 (a first), then b and d tie at 1 (b first).
      expect(census.prefixes.map(prefix => prefix.name)).toEqual(['a', 'c', 'b', 'd']);
    });

    it('emits sub-areas only for prefixes with two or more buckets', () => {
      const census = censusCatalog([
        fixtureRow('alpha.direct', 'query'),
        fixtureRow('alpha.one.a', 'query'),
        fixtureRow('bar.only.x', 'query'),
        fixtureRow('bar.only.y', 'mutation'),
      ]);
      const alpha = census.prefixes.find(prefix => prefix.name === 'alpha');
      const bar = census.prefixes.find(prefix => prefix.name === 'bar');
      // alpha has the direct bucket plus `alpha.one`; bar has a single bucket.
      expect(alpha?.subAreas.map(subArea => subArea.label)).toEqual(['alpha', 'alpha.one']);
      expect(bar?.subAreas).toEqual([]);
    });

    it('sorts sub-area rows by total descending then name ascending', () => {
      const census = censusCatalog([
        fixtureRow('alpha.big.a', 'query'),
        fixtureRow('alpha.big.b', 'query'),
        fixtureRow('alpha.small.c', 'mutation'),
      ]);
      expect(census.prefixes[0]?.subAreas).toEqual([
        { label: 'alpha.big', total: 2 },
        { label: 'alpha.small', total: 1 },
      ]);
    });
  });

  describe('renderCensus', () => {
    it('renders one counts-only table with the totals above it', () => {
      const rendered = renderCensus(
        censusCatalog([fixtureRow('alpha.a', 'query'), fixtureRow('alpha.b', 'query')])
      );
      expect(rendered).toContain(
        '**2 procedures** — **2 queries**, **0 mutations** — under **1 prefixes**.'
      );
      expect(rendered).toContain('| Prefix | Procedures | Queries | Mutations |');
      expect(rendered).toContain('| `alpha` | 2 | 2 | 0 |');
    });

    it('escapes a pipe in a path key so it cannot break the table', () => {
      const rendered = renderCensus(censusCatalog([fixtureRow('al|pha.a', 'query')]));
      expect(rendered).toContain('| `al\\|pha` | 1 | 1 | 0 |');
    });

    it('renders the direct bucket as (direct) and the rest as second segments', () => {
      const rendered = renderCensus(
        censusCatalog([fixtureRow('alpha.direct', 'query'), fixtureRow('alpha.one.a', 'query')])
      );
      expect(rendered).toContain('- `alpha.*` — 2: `(direct)` 1, `one` 1');
    });

    it('emits no sub-areas section when no prefix has two buckets', () => {
      const rendered = renderCensus(
        censusCatalog([fixtureRow('alpha.one.a', 'query'), fixtureRow('alpha.one.b', 'query')])
      );
      expect(rendered).not.toContain('### Sub-areas');
    });

    it('carries no catalog summary or tag into the census', () => {
      const rendered = renderCensus(
        censusCatalog([fixtureRow('alpha.a', 'query'), fixtureRow('beta.b', 'mutation')])
      );
      expect(rendered).not.toContain(SENTINEL_SUMMARY);
      expect(rendered).not.toContain(SENTINEL_TAG);
    });

    it('renders unpadded tables: exact separators and one-space content cells', () => {
      const rendered = renderCensus(
        censusCatalog([
          fixtureRow('alpha.direct', 'query'),
          fixtureRow('alpha.one.a', 'mutation'),
          fixtureRow('beta.q', 'query'),
        ])
      );
      for (const line of rendered.split('\n')) {
        if (!line.trimStart().startsWith('|') || !line.trimEnd().endsWith('|')) continue;
        if (isSeparatorRow(line)) {
          for (const cell of cells(line.trim())) {
            expect(['---', ':---', '---:', ':---:']).toContain(cell);
          }
          continue;
        }
        for (const cell of cells(line.trim())) {
          if (cell.trim() === '') continue;
          expect(cell.startsWith(' ') && cell.endsWith(' ')).toBe(true);
          expect(cell.startsWith('  ')).toBe(false);
          expect(cell.endsWith('  ')).toBe(false);
        }
      }
    });
  });

  describe('renderSkill', () => {
    it('is byte-identical across renders and independent of input order', () => {
      const rows = [
        fixtureRow('alpha.a', 'query'),
        fixtureRow('alpha.b', 'mutation'),
        fixtureRow('beta.c', 'query'),
      ];
      const json = catalogJson(rows);
      expect(renderSkill(json, TEMPLATE)).toBe(renderSkill(json, TEMPLATE));
      expect(renderCensus(censusCatalog([...rows].reverse()))).toBe(
        renderCensus(censusCatalog(rows))
      );
    });

    it('preserves dollar replacement sequences in path keys', () => {
      const rows = [
        fixtureRow('$&alpha.a', 'query'),
        fixtureRow('$$5beta.b', 'mutation'),
        fixtureRow("$'gamma.c", 'query'),
      ];
      const census = renderCensus(censusCatalog(rows));
      // A replacer function is required: `$&`, `$$` and `$'` in the census would
      // otherwise be expanded by String.prototype.replace.
      expect(renderSkill(catalogJson(rows), TEMPLATE)).toBe(`HEADER\n\n${census}\n`);
    });

    it('changes the census when a path is added, because the catalog drives it', () => {
      const rows = [fixtureRow('alpha.a', 'query')];
      const before = censusCatalog(rows);
      const after = censusCatalog([...rows, fixtureRow('alpha.b', 'mutation')]);
      expect(after.total).toBe(before.total + 1);
      expect(after.prefixes[0]?.total).toBe(2);
      expect(after.prefixes[0]?.mutations).toBe(1);
      expect(renderSkill(catalogJson(rows), TEMPLATE)).not.toBe(
        renderSkill(catalogJson([...rows, fixtureRow('alpha.b', 'mutation')]), TEMPLATE)
      );
    });

    it('contains no timestamp, year or sha-like token', () => {
      const rendered = renderSkill(catalogJson([fixtureRow('alpha.a', 'query')]), TEMPLATE);
      expect(rendered).not.toMatch(/\b\d{4}\b/);
      expect(rendered).not.toMatch(/\b[0-9a-f]{40}\b/i);
    });

    it('throws when the template has no {{CENSUS}} token', () => {
      expect(() =>
        renderSkill(catalogJson([fixtureRow('alpha.a', 'query')]), '# no token\n')
      ).toThrow(/CENSUS/);
    });

    it('throws when the catalog has zero rows, naming the catalog as the source of truth', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-skill-test-'));
      try {
        const empty = join(dir, 'empty.json');
        writeFileSync(empty, '{}\n');
        expect(() => readCatalogRows(empty)).toThrow(/zero rows/);
        expect(() => readCatalogRows(empty)).toThrow(/source of truth/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws naming the path when the catalog cannot be read', () => {
      expect(() => readCatalogRows(join(tmpdir(), 'mcp-skill-missing-catalog.json'))).toThrow(
        /mcp-skill-missing-catalog\.json/
      );
    });

    it('throws naming the path when the catalog is not valid JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-skill-test-'));
      try {
        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{"alpha.a": ');
        expect(() => readCatalogRows(broken)).toThrow(/not valid JSON/);
        expect(() => readCatalogRows(broken)).toThrow(/source of truth/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('committed skill', () => {
    const committed = (): string => readFileSync(SKILL_MD_PATH, 'utf8');

    it('renders byte-for-byte from the committed catalog', () => {
      expect(renderSkill(readFileSync(CATALOG_JSON_PATH))).toBe(committed());
    });

    it('stays under the byte limit', () => {
      expect(Buffer.byteLength(committed())).toBeLessThan(SKILL_BYTE_LIMIT);
    });

    it('keeps the census to counts, with no gloss or tag column', () => {
      const skill = committed();
      expect(skill).toContain('| Prefix | Procedures | Queries | Mutations |');
      expect(skill).not.toContain('Gloss');
      expect(skill).not.toContain('Key terms');
    });

    it('lists the largest area’s sub-areas as one comma-joined line', () => {
      const line = committed()
        .split('\n')
        .find(entry => entry.startsWith('- `organizations.*` — '));
      expect(line).toMatch(/^- `organizations\.\*` — \d+: `kiloclaw` \d+, `cloudAgentNext` \d+, /);
    });

    it('declares discovery frontmatter naming the MCP triggers', () => {
      const lines = committed().split('\n');
      expect(lines[0]).toBe('---');
      expect(lines[1]).toBe('name: kilo-mcp');
      const description = lines[2] ?? '';
      for (const token of ['kilo_search', 'kilo_call', 'MCP', 'query', 'mutation']) {
        expect(description).toContain(token);
      }
    });

    it('contains no 4-digit year or sha-like token', () => {
      expect(committed()).not.toMatch(/\b\d{4}\b/);
      expect(committed()).not.toMatch(/\b[0-9a-f]{40}\b/i);
    });
  });
});
