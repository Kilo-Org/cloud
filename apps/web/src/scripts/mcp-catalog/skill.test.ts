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
  censusAreas,
  readCatalogPaths,
  renderCensus,
  renderSkill,
} from './skill';

/**
 * A real catalog row also carries a summary and tags. The fixtures carry
 * sentinels for both, so a test can prove the census leaves them in the catalog
 * where `kilo_search` reads them, instead of copying them into the skill.
 */
const SENTINEL_SUMMARY = 'Sentinel summary that must never reach the skill.';
const SENTINEL_TAG = 'sentineltag';

/** The catalog on disk is an object keyed by path; mirror that shape. */
const catalogJson = (paths: string[]): string =>
  JSON.stringify(
    Object.fromEntries(
      paths.map(path => [path, { kind: 'query', summary: SENTINEL_SUMMARY, tags: [SENTINEL_TAG] }])
    )
  );

/** Minimal template: the census block plus a marker before it. */
const TEMPLATE = 'HEADER\n\n{{CENSUS}}\n';

describe('mcp-catalog skill', () => {
  describe('censusAreas', () => {
    it('collects the distinct first path segments, sorted alphabetically', () => {
      expect(censusAreas(['beta.a', 'alpha.a', 'beta.b.c'])).toEqual(['alpha', 'beta']);
    });
  });

  describe('renderCensus', () => {
    it('renders one bullet per area, with no counts', () => {
      expect(renderCensus(['beta.b', 'alpha.a', 'alpha.b'])).toBe('- `alpha`\n- `beta`');
    });
  });

  describe('renderSkill', () => {
    it('is byte-identical across renders and independent of input order', () => {
      const paths = ['alpha.a', 'alpha.b', 'beta.c'];
      const json = catalogJson(paths);
      expect(renderSkill(json, TEMPLATE)).toBe(renderSkill(json, TEMPLATE));
      expect(renderCensus([...paths].reverse())).toBe(renderCensus(paths));
    });

    it('adds exactly one line when a new area appears', () => {
      expect(renderSkill(catalogJson(['alpha.a']), TEMPLATE)).toBe('HEADER\n\n- `alpha`\n');
      expect(renderSkill(catalogJson(['alpha.a', 'beta.b']), TEMPLATE)).toBe(
        'HEADER\n\n- `alpha`\n- `beta`\n'
      );
    });

    // The reason the census carries names and no counts: two pull requests that
    // each add procedures inside existing areas must generate the same bytes, so
    // the second one merges without a conflict on the generated file.
    it('stays byte-identical when procedures are added inside existing areas', () => {
      const before = renderSkill(catalogJson(['alpha.a', 'beta.b']), TEMPLATE);
      const after = renderSkill(
        catalogJson(['alpha.a', 'alpha.c.d', 'beta.b', 'beta.e']),
        TEMPLATE
      );
      expect(after).toBe(before);
    });

    it('preserves dollar replacement sequences in path keys', () => {
      const paths = ['$&alpha.a', '$$5beta.b', "$'gamma.c"];
      const census = renderCensus(paths);
      // A replacer function is required: `$&`, `$$` and `$'` in the census would
      // otherwise be expanded by String.prototype.replace.
      expect(renderSkill(catalogJson(paths), TEMPLATE)).toBe(`HEADER\n\n${census}\n`);
    });

    it('carries no catalog summary or tag into the skill', () => {
      const paths = ['alpha.a', 'beta.b'];
      // The sentinels ride in the catalog text, so this fails if the generator
      // ever copies a row's summary or tags into the skill again.
      const rendered = renderSkill(catalogJson(paths), TEMPLATE);
      expect(rendered).not.toContain(SENTINEL_SUMMARY);
      expect(rendered).not.toContain(SENTINEL_TAG);
    });

    it('contains no timestamp, year or sha-like token', () => {
      const rendered = renderSkill(catalogJson(['alpha.a']), TEMPLATE);
      expect(rendered).not.toMatch(/\b\d{4}\b/);
      expect(rendered).not.toMatch(/\b[0-9a-f]{40}\b/i);
    });

    it('throws when the template has no {{CENSUS}} token', () => {
      expect(() => renderSkill(catalogJson(['alpha.a']), '# no token\n')).toThrow(/CENSUS/);
    });

    it('throws when the catalog has zero rows, naming the catalog as the source of truth', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-skill-test-'));
      try {
        const empty = join(dir, 'empty.json');
        writeFileSync(empty, '{}\n');
        expect(() => readCatalogPaths(empty)).toThrow(/zero rows/);
        expect(() => readCatalogPaths(empty)).toThrow(/source of truth/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws naming the path when the catalog cannot be read', () => {
      expect(() => readCatalogPaths(join(tmpdir(), 'mcp-skill-missing-catalog.json'))).toThrow(
        /mcp-skill-missing-catalog\.json/
      );
    });

    it('throws naming the path when the catalog is not valid JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-skill-test-'));
      try {
        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{"alpha.a": ');
        expect(() => readCatalogPaths(broken)).toThrow(/not valid JSON/);
        expect(() => readCatalogPaths(broken)).toThrow(/source of truth/);
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

    it('lists the areas as bullets with no counts, so catalog edits do not churn it', () => {
      const skill = committed();
      const areas = skill.slice(skill.indexOf('## Areas'));
      const bullets = areas.split('\n').filter(line => line.startsWith('- '));
      expect(bullets).toContain('- `organizations`');
      expect(bullets).toContain('- `kiloclaw`');
      // A name only: no count, no gloss, no second-segment breakdown.
      expect(bullets.every(line => /^- `[A-Za-z][A-Za-z0-9]*`$/.test(line))).toBe(true);
      expect(areas).not.toContain('| Prefix |');
      expect(skill).not.toContain('Gloss');
      expect(skill).not.toContain('Key terms');
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
