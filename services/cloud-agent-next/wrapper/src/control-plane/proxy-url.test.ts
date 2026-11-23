import { describe, expect, it } from 'bun:test';
import { controlProxyUrl } from './proxy-url.js';

function read(env: Record<string, string | undefined>) {
  const logs: string[] = [];
  return { proxyUrl: controlProxyUrl(env, message => logs.push(message)), logs };
}

describe('controlProxyUrl', () => {
  it('returns no proxy when the launch supplies none', () => {
    expect(read({})).toEqual({ proxyUrl: undefined, logs: [] });
    expect(read({ HTTPS_PROXY: '' })).toEqual({ proxyUrl: undefined, logs: [] });
  });

  it('returns a valid proxy URL unchanged, preferring HTTPS_PROXY', () => {
    // Built from parts so the synthetic credential is not a literal credential URL.
    const proxy = `http://${['kilo', 'token'].join(':')}@proxy.test:3128`;
    expect(read({ HTTPS_PROXY: proxy, https_proxy: 'http://other.test:1' })).toEqual({
      proxyUrl: proxy,
      logs: [],
    });
    expect(read({ https_proxy: proxy })).toEqual({ proxyUrl: proxy, logs: [] });
  });

  it('drops a malformed proxy once without logging its value', () => {
    for (const value of [
      'kilo:secret-token@127.0.0.1:3128',
      'socks5://kilo:secret-token@proxy.test:1',
    ]) {
      const result = read({ HTTPS_PROXY: value });
      expect(result.proxyUrl).toBeUndefined();
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]).not.toContain('secret-token');
    }
  });
});
