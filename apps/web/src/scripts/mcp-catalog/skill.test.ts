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

const fixtureRow = (
  path: string,
  kind: string,
  summary: string,
  tags: string[]
): SkillCatalogRow => ({ path, kind, summary, tags });

/** The catalog on disk is an object keyed by path; mirror that shape. */
const catalogJson = (rows: SkillCatalogRow[]): string =>
  JSON.stringify(
    Object.fromEntries(
      rows.map(row => [row.path, { kind: row.kind, summary: row.summary, tags: row.tags }])
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
        fixtureRow('alpha.a', 'query', 'Alpha a.', ['alpha', 'a']),
        fixtureRow('alpha.b', 'mutation', 'Alpha b.', ['alpha', 'b']),
        fixtureRow('beta.c', 'query', 'Beta c.', ['beta', 'c']),
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
        fixtureRow('a.x', 'query', '', ['a']),
        fixtureRow('a.y', 'query', '', ['a']),
        fixtureRow('b.z', 'query', '', ['b']),
        fixtureRow('c.w', 'query', '', ['c']),
        fixtureRow('c.v', 'query', '', ['c']),
        fixtureRow('d.q', 'query', '', ['d']),
      ]);
      // a and c tie at 2 (a first), then b and d tie at 1 (b first).
      expect(census.prefixes.map(prefix => prefix.name)).toEqual(['a', 'c', 'b', 'd']);
    });

    it('takes the gloss from the shortest path, ties broken alphabetically', () => {
      const census = censusCatalog([
        fixtureRow('alpha.b', 'query', 'B summary. More.', ['alpha']),
        fixtureRow('alpha.a', 'query', 'A summary. More detail.', ['alpha']),
        fixtureRow('alpha.deep.x', 'query', 'Deep summary. More.', ['alpha']),
      ]);
      // alpha.a is the shortest path alphabetically among the two-segment rows.
      expect(census.prefixes[0]?.gloss).toBe('A summary.');
    });

    it('renders no gloss for a blank summary', () => {
      const census = censusCatalog([fixtureRow('alpha.a', 'query', '   ', ['alpha'])]);
      expect(census.prefixes[0]?.gloss).toBe('—');
    });

    it('does not end the gloss at the period of a single-letter abbreviation', () => {
      const census = censusCatalog([
        fixtureRow('alpha.a', 'query', 'Check which (e.g. GitHub, GitLab) are set up.', ['alpha']),
      ]);
      // The period closing `e.g.` is not a sentence end; the gloss runs on.
      expect(census.prefixes[0]?.gloss).toBe('Check which (e.g. GitHub, GitLab) are set up.');
    });

    it('does not end the gloss at the period of i.e.', () => {
      const census = censusCatalog([
        fixtureRow('alpha.a', 'query', 'Use the fallback (i.e. the secondary route) when needed.', [
          'alpha',
        ]),
      ]);
      expect(census.prefixes[0]?.gloss).toBe(
        'Use the fallback (i.e. the secondary route) when needed.'
      );
    });

    it('still ends the gloss at an ordinary sentence period', () => {
      const census = censusCatalog([
        fixtureRow('alpha.a', 'query', 'List the things. More detail follows.', ['alpha']),
      ]);
      expect(census.prefixes[0]?.gloss).toBe('List the things.');
    });

    it('excludes an input-schema-only tag and caps key terms at six', () => {
      const census = censusCatalog([
        fixtureRow('alpha.one.a', 'query', '', ['alpha', 'one', 'organizationid']),
        fixtureRow('alpha.one.b', 'query', '', ['alpha', 'one']),
        fixtureRow('alpha.two.c', 'query', '', ['alpha', 'two']),
        fixtureRow('alpha.three.d', 'query', '', ['alpha', 'three']),
        fixtureRow('alpha.four.e', 'query', '', ['alpha', 'four']),
        fixtureRow('alpha.five.f', 'query', '', ['alpha', 'five']),
        fixtureRow('alpha.six.g', 'query', '', ['alpha', 'six']),
        fixtureRow('alpha.seven.h', 'query', '', ['alpha', 'seven', 'organizationid']),
      ]);
      const terms = census.prefixes[0]?.keyTerms ?? '';
      // `one` occurs twice, so it leads; the rest tie and sort by name. The
      // input-schema-only tag `organizationid` never qualifies.
      expect(terms).toBe('one, five, four, seven, six, three');
      expect(terms.split(', ')).toHaveLength(6);
      expect(terms).not.toContain('organizationid');
      expect(terms).not.toContain('alpha');
    });

    it('emits sub-areas only for prefixes with two or more buckets', () => {
      const census = censusCatalog([
        fixtureRow('alpha.direct', 'query', 'Direct.', ['alpha']),
        fixtureRow('alpha.one.a', 'query', 'One.', ['alpha', 'one']),
        fixtureRow('bar.only.x', 'query', 'Only.', ['bar', 'only']),
        fixtureRow('bar.only.y', 'mutation', 'Only y.', ['bar', 'only']),
      ]);
      const alpha = census.prefixes.find(prefix => prefix.name === 'alpha');
      const bar = census.prefixes.find(prefix => prefix.name === 'bar');
      // alpha has the direct bucket plus `alpha.one`; bar has a single bucket.
      expect(alpha?.subAreas.map(subArea => subArea.label)).toEqual(['alpha', 'alpha.one']);
      expect(bar?.subAreas).toEqual([]);
    });

    it('sorts sub-area rows by total descending then name ascending', () => {
      const census = censusCatalog([
        fixtureRow('alpha.big.a', 'query', '', ['alpha']),
        fixtureRow('alpha.big.b', 'query', '', ['alpha']),
        fixtureRow('alpha.small.c', 'mutation', '', ['alpha']),
      ]);
      expect(census.prefixes[0]?.subAreas).toEqual([
        { label: 'alpha.big', total: 2, queries: 2, mutations: 0 },
        { label: 'alpha.small', total: 1, queries: 0, mutations: 1 },
      ]);
    });
  });

  describe('renderCensus', () => {
    it('escapes a pipe in a gloss so it cannot break the table', () => {
      const census = censusCatalog([fixtureRow('alpha.a', 'query', 'A | B. Rest.', ['alpha'])]);
      expect(census.prefixes[0]?.gloss).toBe('A \\| B.');
      expect(renderCensus(census)).toContain('A \\| B.');
    });

    it('renders the direct bucket with the prefix label', () => {
      const rendered = renderCensus(
        censusCatalog([
          fixtureRow('alpha.direct', 'query', 'Direct.', ['alpha']),
          fixtureRow('alpha.one.a', 'query', 'One.', ['alpha', 'one']),
        ])
      );
      expect(rendered).toContain('#### `alpha.*` — 2 procedures (2 queries, 0 mutations)');
      expect(rendered).toContain('| `alpha` | 1 | 1 | 0 |');
      expect(rendered).toContain('| `alpha.one` | 1 | 1 | 0 |');
    });

    it('emits no sub-areas section when no prefix has two buckets', () => {
      const rendered = renderCensus(
        censusCatalog([
          fixtureRow('alpha.one.a', 'query', 'One.', ['alpha', 'one']),
          fixtureRow('alpha.one.b', 'query', 'Two.', ['alpha', 'one']),
        ])
      );
      expect(rendered).not.toContain('### Sub-areas');
    });

    it('renders unpadded tables: exact separators and one-space content cells', () => {
      const rendered = renderCensus(
        censusCatalog([
          fixtureRow('alpha.direct', 'query', 'Direct | one. More.', ['alpha']),
          fixtureRow('alpha.one.a', 'mutation', 'One.', ['alpha', 'one']),
          fixtureRow('beta.q', 'query', 'Beta.', ['beta']),
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
        fixtureRow('alpha.a', 'query', 'Alpha.', ['alpha']),
        fixtureRow('alpha.b', 'mutation', 'Beta.', ['alpha']),
        fixtureRow('beta.c', 'query', 'Gamma.', ['beta']),
      ];
      const json = catalogJson(rows);
      expect(renderSkill(json, TEMPLATE)).toBe(renderSkill(json, TEMPLATE));
      expect(renderCensus(censusCatalog([...rows].reverse()))).toBe(
        renderCensus(censusCatalog(rows))
      );
    });

    it('changes the census when a path is added, because the catalog drives it', () => {
      const rows = [fixtureRow('alpha.a', 'query', 'Alpha.', ['alpha'])];
      const before = censusCatalog(rows);
      const after = censusCatalog([...rows, fixtureRow('alpha.b', 'mutation', 'Beta.', ['alpha'])]);
      expect(after.total).toBe(before.total + 1);
      expect(after.prefixes[0]?.total).toBe(2);
      expect(after.prefixes[0]?.mutations).toBe(1);
      expect(renderSkill(catalogJson([...rows]), TEMPLATE)).not.toBe(
        renderSkill(
          catalogJson([...rows, fixtureRow('alpha.b', 'mutation', 'Beta.', ['alpha'])]),
          TEMPLATE
        )
      );
    });

    it('contains no timestamp, year or sha-like token', () => {
      const rendered = renderSkill(
        catalogJson([fixtureRow('alpha.a', 'query', 'Alpha.', ['alpha'])]),
        TEMPLATE
      );
      expect(rendered).not.toMatch(/\b\d{4}\b/);
      expect(rendered).not.toMatch(/\b[0-9a-f]{40}\b/i);
    });

    it('throws when the template has no {{CENSUS}} token', () => {
      expect(() =>
        renderSkill(
          catalogJson([fixtureRow('alpha.a', 'query', 'Alpha.', ['alpha'])]),
          '# no token\n'
        )
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

    it('shows the full gloss for a summary that contains an abbreviation', () => {
      const row = committed()
        .split('\n')
        .find(line => line.startsWith('| `platformIntegrations` |'));
      // The `e.g.` in this catalog summary must not truncate the gloss.
      expect(row).toContain(
        'Check which platform integrations (e.g. GitHub, GitLab, Bitbucket) are already configured or missing so you know what setup steps remain for an organization.'
      );
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
