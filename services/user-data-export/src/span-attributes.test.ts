import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Span attribute names are expanded into nested objects when they are exported, so
 * `db.name` becomes `{ db: { name } }`. A key cannot be both a value and an object: when
 * one attribute is a dotted prefix of another, the shorter key wins and the longer keys
 * are dropped silently, with no error anywhere in the Worker.
 *
 * This bit us for real. `export_source_page` set a scalar at `export.page` next to
 * `export.page.records`, `export.page.uncompressed_bytes`, and `export.page.has_more`,
 * and the exported spans carried only `export.page`. The per-page record and byte counts
 * were missing from every trace, which is precisely the data those spans exist to
 * provide. Nothing failed; the attributes just were not there.
 *
 * Scanning source text is unusual for a unit test, but the failure is invisible to
 * ordinary assertions: the Worker behaves correctly and only the telemetry is wrong.
 */
const SOURCE_FILES = ['worker.ts', 'databases.ts'];
const ATTRIBUTE_PATTERN = /'((?:export|db)\.[a-z0-9_.]+)'/g;

function spanAttributeKeys(): string[] {
  return SOURCE_FILES.flatMap(file => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    return [...source.matchAll(ATTRIBUTE_PATTERN)].map(match => match[1] as string);
  });
}

describe('span attribute names', () => {
  it('are discoverable, so the collision check below cannot pass vacuously', () => {
    expect(new Set(spanAttributeKeys()).size).toBeGreaterThan(10);
  });

  it('never use a key that is a dotted prefix of another key', () => {
    const keys = [...new Set(spanAttributeKeys())].sort();

    const collisions = keys.flatMap(candidate =>
      keys
        .filter(other => other.startsWith(`${candidate}.`))
        .map(other => `${candidate} would shadow ${other}`)
    );

    expect(collisions).toEqual([]);
  });
});
