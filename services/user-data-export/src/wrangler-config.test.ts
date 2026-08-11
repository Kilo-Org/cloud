import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const config = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf-8');

describe('wrangler config', () => {
  /**
   * Every warehouse-backed source routes through EXPORT_WAREHOUSE_DB, so a placeholder
   * id reaching production fails every export at its first warehouse read. Deploy
   * validation is not a reliable backstop, so fail here instead.
   */
  it('carries no placeholder binding ids', () => {
    const placeholders = config
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(entry => /REPLACE_WITH_/.test(entry.line));

    expect(placeholders).toEqual([]);
  });

  it('binds both the primary replica and the export warehouse', () => {
    expect(config).toContain('"EXPORT_REPLICA_DB"');
    expect(config).toContain('"EXPORT_WAREHOUSE_DB"');
  });

  it('points local development at the warehouse database, not the primary', () => {
    const warehouseSection = config.slice(config.indexOf('"EXPORT_WAREHOUSE_DB"'));
    const localConnection = /"localConnectionString":\s*"([^"]+)"/.exec(warehouseSection)?.[1];

    expect(localConnection).toBeDefined();
    expect(localConnection).toMatch(/\/data_export$/);
  });
});
