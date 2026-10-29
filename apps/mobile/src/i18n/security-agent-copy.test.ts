import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';

/**
 * A GitHub App scope such as `vulnerability_alerts` is an API identifier, not
 * copy: the reader cannot act on a token and cannot find it in GitHub's own
 * screens. One such string reached the Security Agent reauthorize screen, so
 * every catalog's Security Agent copy is checked for snake_case identifiers.
 */
const INTERNAL_IDENTIFIER =
  /(?:^|[^A-Za-z0-9])[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+(?:[^A-Za-z0-9]|$)/;

function copyStrings(node: unknown, path: string, out: [string, string][]): void {
  if (typeof node === 'string') {
    out.push([path, node]);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      copyStrings(child, `${path}.${key}`, out);
    }
  }
}

describe('Security Agent copy', () => {
  it('names capabilities, never an internal permission identifier', () => {
    const found: string[] = [];
    for (const [language, load] of Object.entries(CATALOG_LOADERS)) {
      const catalog = load() as { securityAgent?: unknown } | undefined;
      const strings: [string, string][] = [];
      if (catalog?.securityAgent) {
        copyStrings(catalog.securityAgent, 'securityAgent', strings);
      }
      for (const [path, value] of strings) {
        if (INTERNAL_IDENTIFIER.test(value)) {
          found.push(`${language} ${path}: ${value}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  /**
   * One name per language. `common.securityAgent` renders the screen header and
   * the Home and Profile tiles, so a body string that still spells the English
   * name shows the reader two names for one feature — the defect the German
   * reauthorize screen carried. English is the one catalog where the English
   * name is its own.
   */
  it('uses the catalog name for the feature in every catalog string', () => {
    const found: string[] = [];
    for (const [language, load] of Object.entries(CATALOG_LOADERS)) {
      const catalog = load() as
        | { common?: { securityAgent?: string }; securityAgent?: unknown }
        | undefined;
      const name = catalog?.common?.securityAgent;
      const strings: [string, string][] = [];
      if (catalog?.securityAgent) {
        copyStrings(catalog.securityAgent, 'securityAgent', strings);
      }
      if (name && name !== 'Security Agent') {
        for (const [path, value] of strings) {
          if (value.includes('Security Agent')) {
            found.push(`${language} ${path}: ${value}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
