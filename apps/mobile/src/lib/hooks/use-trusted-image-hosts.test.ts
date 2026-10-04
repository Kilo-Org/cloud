import { describe, expect, it, vi } from 'vitest';

import { formatTrustedImageHost } from './use-trusted-image-hosts';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const RN_URL_HOSTNAME_REGEX = /^https?:\/\/(?:[^@]+@)?([^:/?#]+)/;

/** React Native's polyfilled URL.hostname, reproduced. */
function rnUrlHostname(url: string): string {
  return RN_URL_HOSTNAME_REGEX.exec(url)?.[1] ?? '';
}

describe('formatTrustedImageHost', () => {
  it('keys a plain HTTPS host by its lowercased hostname', () => {
    expect(formatTrustedImageHost('https://Example.COM/a.png')).toBe('example.com');
  });

  it('keeps a non-default port and drops a default port', () => {
    expect(formatTrustedImageHost('https://example.com:8443/a.png')).toBe('example.com:8443');
    expect(formatTrustedImageHost('https://example.com:443/a.png')).toBe('example.com');
    expect(formatTrustedImageHost('http://example.com:80/a.png')).toBe('example.com');
  });

  it('canonicalizes a numeric port to the WHATWG endpoint', () => {
    // WHATWG drops leading zeros, so :0443 is the default HTTPS port and must
    // key as the same host a trusted entry for :443 covers.
    expect(formatTrustedImageHost('https://example.com:0443/a.png')).toBe('example.com');
    expect(formatTrustedImageHost('http://example.com:0443/a.png')).toBe('example.com:443');
    expect(formatTrustedImageHost('https://example.com:099/a.png')).toBe('example.com:99');
    // A port above the 16-bit maximum fails WHATWG parsing; the native client
    // never fetches it, so it must never key as a host.
    expect(formatTrustedImageHost('https://example.com:65536/a.png')).toBeNull();
  });

  it('strips userinfo from the authority', () => {
    expect(formatTrustedImageHost('https://user:pass@example.com/a.png')).toBe('example.com');
  });

  it('does not key a path @ as the host', () => {
    // React Native's URL.hostname lets [^@]+ cross the path separator, so the
    // polyfill reads this URL as trusted.com while the native client fetches
    // from attacker.com. The key must name the host the request reaches.
    expect(rnUrlHostname('https://attacker.com/x@trusted.com/p.png')).toBe('trusted.com');
    expect(formatTrustedImageHost('https://attacker.com/x@trusted.com/p.png')).toBe('attacker.com');
  });

  it('treats a backslash as the end of the authority', () => {
    const backslash = String.fromCodePoint(92);
    expect(formatTrustedImageHost(`https://attacker.com${backslash}x@trusted.com/p.png`)).toBe(
      'attacker.com'
    );
  });

  it('keeps a bracketed IPv6 host and its port', () => {
    expect(formatTrustedImageHost('https://[2001:DB8::1]:8443/a.png')).toBe('[2001:db8::1]:8443');
  });

  it('returns null for non-HTTP schemes and malformed authorities', () => {
    expect(formatTrustedImageHost('data:image/png;base64,AAAA')).toBeNull();
    expect(formatTrustedImageHost('https://')).toBeNull();
    expect(formatTrustedImageHost('https://example.com:notaport/a.png')).toBeNull();
    expect(formatTrustedImageHost('https://exa mple.com/a.png')).toBeNull();
    expect(formatTrustedImageHost('not a url')).toBeNull();
  });
});
