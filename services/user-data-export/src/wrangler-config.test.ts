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

  // The warehouse is the only database an export source reads. A binding to the primary
  // would let one back in, and with it a file whose fields are as of different moments.
  it('binds the export warehouse and no replica of the primary', () => {
    expect(config).toContain('"EXPORT_WAREHOUSE_DB"');
    expect(config).not.toContain('"EXPORT_REPLICA_DB"');
  });

  /**
   * Traces reached Axiom as nothing but the destination's one-off pre-flight span
   * because this config enabled logs only. `observability.enabled` does not turn on
   * tracing while the feature is in beta, and a destination receives spans only from
   * Workers that name it, so both keys have to survive future edits to this file.
   */
  it('enables tracing and names the traces destination', () => {
    const observability = config.slice(config.indexOf('"observability"'));
    const traces = observability.slice(observability.indexOf('"traces"'));

    expect(traces).toMatch(/"enabled":\s*true/);
    expect(traces).toContain('"axiom-traces"');
  });

  it('points local development at the warehouse database, not the primary', () => {
    const warehouseSection = config.slice(config.indexOf('"EXPORT_WAREHOUSE_DB"'));
    const localConnection = /"localConnectionString":\s*"([^"]+)"/.exec(warehouseSection)?.[1];

    expect(localConnection).toBeDefined();
    expect(localConnection).toMatch(/\/data_export$/);
  });
});
