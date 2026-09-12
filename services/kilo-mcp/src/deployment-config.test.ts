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
