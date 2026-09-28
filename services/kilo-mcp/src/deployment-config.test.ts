import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { parseConfigFileTextToJson } from 'typescript';
import { expect, it } from 'vitest';

it('uses a real or automatically provisioned production OAuth KV namespace', () => {
  const parsed = parseConfigFileTextToJson(
    'wrangler.jsonc',
    readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  );
  expect(parsed.error).toBeUndefined();
  const config = parsed.config as { kv_namespaces: Array<{ binding: string; id?: string }> };
  const binding = config.kv_namespaces.find(item => item.binding === 'OAUTH_KV');
  expect(binding).toBeDefined();
  if (binding?.id !== undefined) {
    expect(binding.id).toMatch(/^[a-f0-9]{32}$/);
    expect(binding.id).not.toBe('0'.repeat(32));
  }
});

it('marks the dev AI and Vectorize bindings remote so semantic search is reachable locally', () => {
  // Workers AI and Vectorize have no local emulation: `wrangler dev` reports
  // them "not supported" and every search degrades to token-only, so the
  // semantic half of hybrid search can never be exercised locally. The
  // supported fix is `remote: true` on the binding, which proxies the local
  // dev worker to the real dev resources (src/search-knn.ts + wrangler's
  // binding table). Assert it here so a regression is caught in CI instead of
  // silently disabling semantic search at sign-in.
  const parsed = parseConfigFileTextToJson(
    'wrangler.jsonc',
    readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  );
  expect(parsed.error).toBeUndefined();
  const config = parsed.config as {
    env?: {
      dev?: {
        ai?: { binding: string; remote?: boolean };
        vectorize?: Array<{ binding: string; index_name: string; remote?: boolean }>;
      };
    };
  };
  const dev = config.env?.dev;
  expect(dev?.ai).toMatchObject({ binding: 'AI', remote: true });
  const vectorize = dev?.vectorize?.find(item => item.binding === 'VECTORIZE');
  expect(vectorize).toMatchObject({ index_name: 'kilo-mcp-catalog-dev', remote: true });
});
