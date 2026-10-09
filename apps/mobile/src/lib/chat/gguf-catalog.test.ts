
import { describe, expect, it } from 'vitest';

import { GGUF_CATALOG, readGgufLink } from './gguf-catalog';

describe('a direct download link', () => {
  it('accepts only an HTTPS .gguf link and names the model from the file', () => {
    const ok = readGgufLink('https://example.com/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf');
    expect(ok).toEqual({ ok: true, value: { url: 'https://example.com/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', name: 'Qwen2.5-0.5B-Instruct-Q4_K_M' } });
  });

  it('reads a percent-encoded file name', () => {
    const ok = readGgufLink('https://example.com/a%20b.gguf');
    expect(ok.ok && ok.value.name).toBe('a b');
  });

  it.each([
    ['not a link', 'invalidUrl'],
    ['', 'invalidUrl'],
    ['http://example.com/model.gguf', 'insecureUrl'],
    ['ftp://example.com/model.gguf', 'invalidUrl'],
    ['https://user:pass@example.com/model.gguf', 'credentialsUrl'],
    ['https://example.com/model.bin', 'notGguf'],
    ['https://example.com/.gguf', 'notGguf'],
    ['https://example.com/', 'notGguf'],
  ])('refuses %s', (input, problem) => {
    expect(readGgufLink(input)).toEqual({ ok: false, problem });
  });

  it('offers curated models pinned to a revision with a size and a license', () => {
    expect(GGUF_CATALOG.length).toBeGreaterThanOrEqual(3);
    for (const model of GGUF_CATALOG) {
      expect(readGgufLink(model.url).ok).toBe(true);
      expect(model.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(model.sizeBytes).toBeGreaterThan(0);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.license).not.toBe('');
    }
  });
});
