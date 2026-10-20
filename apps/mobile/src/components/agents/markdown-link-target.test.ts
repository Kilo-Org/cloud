import { describe, expect, it } from 'vitest';

import { parseMarkdownLinkTarget } from './markdown-link-target';

const SCRIPT_SCHEME_HREF = ['java', 'script:alert(1)'].join('');

describe('parseMarkdownLinkTarget web links', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['https:/example.com', 'https://example.com/'],
    ['https:example.com', 'https://example.com/'],
    ['https:///example.com', 'https://example.com/'],
    [String.raw`https:\\example.com`, 'https://example.com/'],
    ['http:example.com/path', 'http://example.com/path'],
    ['  https://example.com/path  ', 'https://example.com/path'],
  ])('resolves %j to the canonical %j', (href, expectedHref) => {
    expect(parseMarkdownLinkTarget(href)).toMatchObject({
      kind: 'web',
      href: expectedHref,
      host: 'example.com',
    });
  });

  it('keeps the path, query, and fragment in the canonical URL', () => {
    expect(parseMarkdownLinkTarget('https://example.com/a/b?q=1#frag')).toMatchObject({
      href: 'https://example.com/a/b?q=1#frag',
    });
    expect(parseMarkdownLinkTarget('https://example.com?q=1')).toMatchObject({
      href: 'https://example.com/?q=1',
    });
    expect(parseMarkdownLinkTarget('https://example.com#frag')).toMatchObject({
      href: 'https://example.com/#frag',
    });
  });

  it('lowercases the scheme and hostname', () => {
    expect(parseMarkdownLinkTarget('HTTPS://Example.COM/Path')).toEqual({
      kind: 'web',
      scheme: 'https',
      host: 'example.com',
      href: 'https://example.com/Path',
    });
  });

  it('keeps a non-default port and drops the protocol default', () => {
    expect(parseMarkdownLinkTarget('https://example.com:8443/x')).toMatchObject({
      host: 'example.com:8443',
      href: 'https://example.com:8443/x',
    });
    expect(parseMarkdownLinkTarget('https://example.com:443/x')).toMatchObject({
      host: 'example.com',
      href: 'https://example.com/x',
    });
    expect(parseMarkdownLinkTarget('http://example.com:80')).toMatchObject({
      host: 'example.com',
      href: 'http://example.com/',
    });
  });

  it('drops userinfo so the opened URL matches the confirmed host', () => {
    expect(parseMarkdownLinkTarget('https://user:secret@example.com/x')).toEqual({
      kind: 'web',
      scheme: 'https',
      host: 'example.com',
      href: 'https://example.com/x',
    });
    expect(parseMarkdownLinkTarget('https://evil.example@example.com/x')).toMatchObject({
      host: 'example.com',
      href: 'https://example.com/x',
    });
  });

  it('drops a trailing dot from the hostname', () => {
    expect(parseMarkdownLinkTarget('https://example.com./x')).toMatchObject({
      host: 'example.com',
      href: 'https://example.com/x',
    });
  });

  it('keeps a bracketed IPv6 host', () => {
    expect(parseMarkdownLinkTarget('https://[2001:DB8::1]:8080/x')).toMatchObject({
      host: '[2001:db8::1]:8080',
      href: 'https://[2001:db8::1]:8080/x',
    });
  });

  it.each([
    '//example.com',
    '///example.com',
    'https://',
    'https:///',
    'https://exa mple.com/',
    'https://exa\tmple.com/',
    'https://example.com:abc/',
    'https://example.com:99999/',
    'https://[2001:db8::1',
    'https://user@/',
    'not a url',
    '',
    '   ',
  ])('rejects the unparseable web value %j', href => {
    expect(parseMarkdownLinkTarget(href)).toBeNull();
  });
});

describe('parseMarkdownLinkTarget non-web schemes', () => {
  it('allows mailto and tel', () => {
    expect(parseMarkdownLinkTarget('mailto:hello@kilo.ai')).toEqual({
      kind: 'scheme',
      scheme: 'mailto',
      href: 'mailto:hello@kilo.ai',
    });
    expect(parseMarkdownLinkTarget('MAILTO:hello@kilo.ai')).toEqual({
      kind: 'scheme',
      scheme: 'mailto',
      href: 'mailto:hello@kilo.ai',
    });
    expect(parseMarkdownLinkTarget('tel:+38111222333')).toEqual({
      kind: 'scheme',
      scheme: 'tel',
      href: 'tel:+38111222333',
    });
  });

  it('rejects an empty target', () => {
    expect(parseMarkdownLinkTarget('mailto:')).toBeNull();
    expect(parseMarkdownLinkTarget('tel:  ')).toBeNull();
  });

  it('rejects control characters in the target', () => {
    expect(parseMarkdownLinkTarget('tel:+1\n2')).toBeNull();
  });

  it.each([
    'ftp://example.com',
    SCRIPT_SCHEME_HREF,
    'data:text/html,hello',
    'file:///etc/passwd',
    'sms:+38111222333',
    'intent://scan',
    'vbscript:msgbox(1)',
  ])('rejects the scheme in %j', href => {
    expect(parseMarkdownLinkTarget(href)).toBeNull();
  });
});
