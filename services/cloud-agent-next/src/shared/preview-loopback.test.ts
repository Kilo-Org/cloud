import { describe, expect, it } from 'vitest';
import { isPreviewLoopbackHostname } from './preview-loopback.js';

/** The predicate takes hostnames in the form the WHATWG URL parser produces. */
function hostnameOf(href: string): string {
  return new URL(href).hostname;
}

describe('isPreviewLoopbackHostname', () => {
  it.each([
    'http://localhost:3000/',
    'http://localhost.:3000/',
    'http://LOCALHOST:3000/',
    'http://app.localhost:3000/',
    'http://127.0.0.1:3000/',
    'http://127.0.0.2:3000/',
    'http://127.255.255.254:3000/',
    'http://127.1:3000/',
    'http://2130706433:3000/',
    'http://0.0.0.0:3000/',
    'http://[::1]:3000/',
    'http://[::]:3000/',
    'http://[::ffff:7f00:1]:3000/',
    'http://[::ffff:127.0.0.1]:3000/',
    'http://[::ffff:127.255.255.254]:3000/',
    'http://[0:0:0:0:0:ffff:7f00:1]:3000/',
  ])('recognizes %s as the sandbox itself', href => {
    expect(isPreviewLoopbackHostname(hostnameOf(href))).toBe(true);
  });

  it.each([
    'https://example.com:3000/',
    'http://10.0.0.1:3000/',
    'http://0.0.0.1:3000/',
    'http://128.0.0.1:3000/',
    'http://localhost.example.com:3000/',
    'http://notlocalhost:3000/',
    'http://[2001:db8::1]:3000/',
    'http://[::ffff:8080:1]:3000/',
    'http://[::1:2]:3000/',
  ])('leaves %s as an ordinary host', href => {
    expect(isPreviewLoopbackHostname(hostnameOf(href))).toBe(false);
  });

  it('rejects text that is not a hostname in URL form', () => {
    expect(isPreviewLoopbackHostname('')).toBe(false);
    expect(isPreviewLoopbackHostname('127.0.0')).toBe(false);
    expect(isPreviewLoopbackHostname('[::1]extra')).toBe(false);
    expect(isPreviewLoopbackHostname('[::::1]')).toBe(false);
    expect(isPreviewLoopbackHostname('[::g]')).toBe(false);
  });
});
