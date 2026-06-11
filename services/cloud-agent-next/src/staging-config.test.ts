import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

type WranglerConfig = {
  env?: {
    staging?: {
      triggers?: { crons?: string[] };
      secrets_store_secrets?: unknown[];
    };
  };
};

function readWranglerConfig(): WranglerConfig {
  const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);
  return parse(readFileSync(configPath, 'utf8')) as WranglerConfig;
}

describe('staging deployment configuration', () => {
  it('does not schedule production report retention cleanup', () => {
    const config = readWranglerConfig();

    expect(config.env?.staging?.triggers?.crons ?? []).toEqual([]);
  });

  it('uses direct Worker secrets instead of Secrets Store bindings', () => {
    const config = readWranglerConfig();

    expect(config.env?.staging?.secrets_store_secrets).toBeUndefined();
  });
});
