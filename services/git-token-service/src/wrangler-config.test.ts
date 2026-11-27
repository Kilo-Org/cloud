import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

// Resolves the effective config Wrangler deploys, inheritance applied, rather
// than the raw file, so a key the environment silently inherits is caught too.
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

const PRODUCTION_HYPERDRIVE = '624ec80650dd414199349f4e217ddb10';
const PRODUCTION_TOKEN_CACHE = 'ab4d777d134a43248639044613ea29ef';
const PRODUCTION_HOST = 'git-token-service.kilosessions.ai';
const LOCAL_DATABASE = 'postgres://postgres:postgres@localhost:5432/postgres';

describe('git-token-service wrangler.jsonc', () => {
  it('keeps the production render as it was', () => {
    const production = unstable_readConfig({ config });

    expect(production.name).toBe('git-token-service');
    expect(production.targetEnvironment).toBeUndefined();
    expect(production.definedEnvironments).toEqual(['dev']);
    expect(production.workers_dev).toBe(false);
    expect(production.preview_urls).toBe(false);
    expect(production.routes).toEqual([
      { pattern: PRODUCTION_HOST, zone_name: 'kilosessions.ai', custom_domain: true },
    ]);
    expect(production.kv_namespaces).toEqual([
      { binding: 'TOKEN_CACHE', id: PRODUCTION_TOKEN_CACHE },
    ]);
    expect(production.hyperdrive).toEqual([
      { binding: 'HYPERDRIVE', id: PRODUCTION_HYPERDRIVE, localConnectionString: LOCAL_DATABASE },
    ]);
  });

  it('keeps env.dev local: no ingress and no production Hyperdrive', () => {
    const dev = unstable_readConfig({ config, env: 'dev' });

    expect(dev.name).toBe('git-token-service-dev');
    expect(dev.targetEnvironment).toBe('dev');
    expect(dev.workers_dev).toBe(false);
    expect(dev.preview_urls).toBe(false);
    expect(dev.routes).toEqual([]);
    expect(dev.route).toBeUndefined();
    // `local-only` names no Hyperdrive resource; local dev uses the loopback database.
    expect(dev.hyperdrive).toEqual([
      { binding: 'HYPERDRIVE', id: 'local-only', localConnectionString: LOCAL_DATABASE },
    ]);

    const rendered = JSON.stringify(dev);
    for (const absentValue of [
      PRODUCTION_HYPERDRIVE,
      PRODUCTION_TOKEN_CACHE,
      PRODUCTION_HOST,
      'kilosessions.ai',
      'custom_domain',
    ]) {
      expect(rendered).not.toContain(absentValue);
    }
  });

  it('refuses an undeclared environment instead of rendering production', () => {
    // Wrangler's own reason when `env` is declared but has no section of that name.
    expect(() => unstable_readConfig({ config, env: 'staging' })).toThrow(
      'No environment found in configuration with name "staging".'
    );
  });
});
