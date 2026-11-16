import { describe, expect, it, vi } from 'vitest';
import { createPublicResolver } from './resolver.js';
import { publicHttpsFetch } from './https-transport.js';

function answer(addresses: string[], overrides: Record<string, unknown> = {}) {
  return Response.json({
    Status: 0,
    TC: false,
    Question: [{ name: 'github.com.', type: 1 }],
    Answer: addresses.map(data => ({ type: 1, data })),
    ...overrides,
  });
}
describe('fixed public resolver', () => {
  it('pins the resolver itself and returns checked addresses for the exact question', async () => {
    const query = vi.fn(async (request: Request, address: string) => {
      expect(address).toBe('1.1.1.1');
      expect(new URL(request.url).hostname).toBe('cloudflare-dns.com');
      expect(new URL(request.url).searchParams.get('name')).toBe('github.com');
      return answer(['140.82.112.3', '140.82.112.3']);
    });
    expect(await createPublicResolver(query)('github.com', new AbortController().signal)).toEqual([
      '140.82.112.3',
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([{ addresses: ['10.84.1.1'] }, { addresses: ['140.82.112.3', '169.254.169.254'] }])(
    'refuses private answers without resolver fallback: %j',
    async ({ addresses }) => {
      const query = vi.fn(async () => answer(addresses));
      await expect(
        createPublicResolver(query)('github.com', new AbortController().signal)
      ).rejects.toThrow('destination_denied');
      expect(query).toHaveBeenCalledTimes(1);
    }
  );
  it.each([{ TC: true }, { Status: 3 }, { Question: [{ name: 'other.example.', type: 1 }] }])(
    'refuses invalid DNS evidence: %j',
    async invalid => {
      const query = vi.fn(async () => answer(['140.82.112.3'], invalid));
      await expect(
        createPublicResolver(query)('github.com', new AbortController().signal)
      ).rejects.toThrow('dns_unavailable');
      expect(query).toHaveBeenCalledTimes(2);
    }
  );
  it('refuses an answer without a usable IPv4 address', async () => {
    const query = vi.fn(async () => answer([]));
    await expect(
      createPublicResolver(query)('github.com', new AbortController().signal)
    ).rejects.toThrow('destination_denied');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('uses the second fixed resolver after a bounded transport failure', async () => {
    const query = vi.fn(async (_request: Request, address: string) => {
      if (address === '1.1.1.1') throw new Error('temporary transport failure');
      return answer(['140.82.112.3']);
    });
    expect(await createPublicResolver(query)('github.com', new AbortController().signal)).toEqual([
      '140.82.112.3',
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('cancels before performing a DNS request', async () => {
    const query = vi.fn(async () => answer(['140.82.112.3']));
    const controller = new AbortController();
    controller.abort();
    await expect(createPublicResolver(query)('github.com', controller.signal)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('checks all returned addresses again before creating an upstream socket', async () => {
    const fetch = publicHttpsFetch(async () => ['140.82.112.3', '127.0.0.1']);
    await expect(fetch(new Request('https://github.com/'))).rejects.toThrow('destination_denied');
  });
});
